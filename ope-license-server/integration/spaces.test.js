// ABOUTME: Integration test: OPE and atproto spaces end to end, on Bluesky's own spaces-alpha PDS
// ABOUTME: run in-process (@atproto/dev-env). Not mocked: the PDS signs readers in and calls our server.

// The whole path, in order:
//   1. A subscriber links their atproto account on the License Server by signing in
//      with it (atproto OAuth, driven through the PDS's real sign-in page).
//   2. A publisher creates a space under the `managedspace` policy, naming this License
//      Server as its managing app, and writes posts into it.
//   3. An app asks the PDS for a space credential for the subscriber. The PDS resolves
//      our did:web document and calls our checkAccess with service auth signed by
//      the publisher's key. We answer from the subscriber's OPE subscription.
//   4. The app reads the space's posts with that credential, signing each request
//      with the key the credential is bound to (RFC 9421).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import { P256Keypair } from "@atproto/crypto";
import { createSpaceSigHeaders } from "@atproto/space";
import { createRequire } from "node:module";

// Playwright drives the PDS's sign-in page. Found from this package or NODE_PATH; the
// linking tests are skipped without it.
let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch { /* skipped below */ }

const LS_PORT = 4390;
const SCOPE = "http://localhost:8080/posts/";
const SPACE_TYPE = "com.example.group"; // the space type Bluesky's own space tests use
const SKEY = "subscribers";
const POSTS = "com.example.post"; // the record type the publisher writes into its space

let network, pds, publisher, ada, space, ls, server, browser;
const lsCalls = [];

async function xrpc(method, { body, params, token, headers, base }) {
  const url = new URL(`${base || pds.url}/xrpc/${method}`);
  if (params) url.search = new URLSearchParams(params);
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}

// What an atproto app does to read a space for a user: a delegation token from the
// user's own PDS, exchanged at the space's host for a credential bound to the app's key.
async function requestCredential(actor) {
  const delegation = await xrpc("com.atproto.space.getDelegationToken", { token: actor.accessJwt, params: { space } });
  assert.equal(delegation.status, 200, "the reader's PDS issues a delegation token");
  const key = await P256Keypair.create();
  const res = await xrpc("com.atproto.space.authorizeSpaceSync", { body: { space, credentialKey: key.did(), delegationToken: delegation.token } });
  return { ...res, key };
}

// How an app reads the publisher's posts in the space: the credential, plus an HTTP
// Message Signature over it and the audience (the repo being read), made with the
// key the credential is bound to.
async function readPosts({ credential, key }) {
  const { headers } = await createSpaceSigHeaders({ keypair: key, authorization: `Atproto-Space-Credential ${credential}`, audience: publisher.did });
  return xrpc("com.atproto.space.listRecords", { params: { space, repo: publisher.did, collection: POSTS }, headers });
}

// Set ada's subscription on the License Server, keeping everything else (her link).
function subscription(state) {
  const saved = ls.exportState();
  saved.maps.entitlements = [["ada", [{ id: "ent_1", resource: SCOPE, coverage: "collection", state, publisher: "http://localhost:8080/" }]]];
  ls.importState(saved);
}

// Sign in to the License Server as `account`, then link an atproto account through the
// PDS's own sign-in page. `decide` is the button pressed on the PDS's consent screen.
async function linkAtproto(account, { handle, password, decide = "Authorize" }) {
  const page = await browser.newPage();
  try {
    await page.goto(`${ls.ISSUER}/account`);
    await page.fill("input[name=account]", account);
    await page.click("button");
    await page.fill("input[name=handle]", handle);
    await page.click("text=Sign in to link");
    await page.waitForURL(`${pds.url}/oauth/authorize**`);
    await page.fill("input[type=password]", password);
    await page.click("button:has-text('Sign in')");
    await page.click(`button:has-text('${decide}')`);
    await page.waitForURL(`${ls.ISSUER}/account**`);
    return { url: page.url(), text: await page.innerText("body") };
  } finally {
    await page.close();
  }
}

before(async () => {
  network = await TestNetworkNoAppView.create({});
  pds = network.pds;
  const account = (name) => xrpc("com.atproto.server.createAccount", { body: { handle: `${name}.test`, email: `${name}@test.com`, password: `${name}-pass` } });
  publisher = await account("publisher");
  ada = await account("ada");
  space = `at://${publisher.did}/space/${SPACE_TYPE}/${SKEY}`;

  // Our License Server, configured to manage the publisher's space.
  process.env.OPE_ISSUER = `http://localhost:${LS_PORT}`;
  process.env.PORT = String(LS_PORT);
  process.env.OPE_PROTECTED_RESOURCES = SCOPE;
  process.env.OPE_PLC_URL = network.plc.url;
  process.env.OPE_ATPROTO_HANDLE_RESOLVER = pds.url; // .test handles resolve at the PDS
  process.env.OPE_MANAGED_SPACES = JSON.stringify([{ space, resource: SCOPE }]);
  ls = await import("../app.js");
  server = ls.app.listen(LS_PORT);
  server.on("request", (req) => lsCalls.push(req.url));
  await new Promise((r) => server.once("listening", r));
  if (chromium) browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  await network?.close();
});

const linking = { skip: chromium ? false : "Playwright isn't installed" };

describe("Linking an atproto account by signing in with it", () => {
  it("links nothing when the subscriber denies access on their PDS", linking, async () => {
    const result = await linkAtproto("ada", { handle: "ada.test", password: "ada-pass", decide: "Deny access" });
    assert.match(decodeURIComponent(result.url), /atproto_error=access_denied/);
    assert.equal(ls.exportState().maps.atprotoLinks.length, 0);
  });

  it("links the DID the subscriber's own PDS vouches for", linking, async () => {
    const result = await linkAtproto("ada", { handle: "ada.test", password: "ada-pass" });
    assert.match(result.text, /@ada\.test/);
    assert.deepEqual(ls.exportState().maps.atprotoLinks, [["ada", { did: ada.did, handle: "ada.test" }]]);
  });
});

describe("A space on Bluesky's spaces-alpha PDS, managed by the License Server", () => {
  let held; // a credential issued while ada was subscribed

  before(() => {
    // Without Playwright, link ada directly so the space tests still run.
    if (!chromium) {
      const saved = ls.exportState();
      saved.maps.atprotoLinks = [["ada", { did: ada.did, handle: "ada.test" }]];
      ls.importState(saved);
    }
  });

  it("creates a managedspace naming the License Server as its managing app", async () => {
    const created = await xrpc("com.atproto.space.createSpace", {
      token: publisher.accessJwt,
      body: { spaceType: SPACE_TYPE, skey: SKEY, policy: { $type: "com.atproto.managedspace.policy", managingApp: ls.spaceManager.managingApp } },
    });
    assert.equal(created.status, 200, JSON.stringify(created));
    assert.equal(created.space, space);
  });

  it("lets the publisher write subscriber-only posts into the space", async () => {
    for (const text of ["Subscribers only: the first post", "Subscribers only: the second post"]) {
      const written = await xrpc("com.atproto.space.createRecord", {
        token: publisher.accessJwt,
        body: { space, repo: publisher.did, collection: POSTS, validate: false, record: { $type: POSTS, text, createdAt: new Date().toISOString() } },
      });
      assert.equal(written.status, 200, JSON.stringify(written));
    }
  });

  it("refuses a reader with no subscription: the PDS asked us, and we said no", async () => {
    subscription("ended");
    lsCalls.length = 0;
    const cred = await requestCredential(ada);
    assert.equal(cred.status, 400);
    assert.equal(cred.error, "SpaceNotFound", "a refused reader can't even see the space");
    assert.ok(lsCalls.some((u) => u.includes("com.atproto.managedspace.checkAccess")), "the PDS consulted the License Server");
  });

  it("issues a space credential to a subscribed reader with a linked account", async () => {
    subscription("active");
    const cred = await requestCredential(ada);
    assert.equal(cred.status, 200, JSON.stringify(cred));
    const header = JSON.parse(Buffer.from(cred.credential.split(".")[0], "base64url"));
    assert.equal(header.typ, "atproto-space-credential+jwt");
    const claims = JSON.parse(Buffer.from(cred.credential.split(".")[1], "base64url"));
    assert.equal(claims.sub, space, "a credential for this space");
    assert.equal(claims.iss, publisher.did, "issued by the space's authority, the publisher");
    assert.equal(claims.cnf?.kid, cred.key.did(), "bound to the app's key");
    assert.ok(claims.exp - claims.iat <= 3600, "short-lived: within the hour OPE allows");
    held = cred;
  });

  it("lets the app read the space's posts with that credential", async () => {
    const posts = await readPosts(held);
    assert.equal(posts.status, 200, JSON.stringify(posts));
    assert.deepEqual(posts.records.map((r) => r.value.text).sort(), ["Subscribers only: the first post", "Subscribers only: the second post"]);
  });

  it("refuses a read signed with a different key than the credential's", async () => {
    const posts = await readPosts({ credential: held.credential, key: await P256Keypair.create() });
    assert.equal(posts.status, 401);
  });

  it("refuses a new credential once the subscription is cancelled", async () => {
    subscription("ended");
    const cred = await requestCredential(ada);
    assert.equal(cred.status, 400);
    assert.equal(cred.error, "SpaceNotFound");
  });

  it("still honors a credential issued before the cancellation, until it expires", async () => {
    // Only the space's authority can revoke a credential early; the managing app can't.
    // So a cancellation takes effect at the next credential request, and a credential
    // already issued lasts its lifetime: 10 minutes by default, inside OPE's hour.
    const posts = await readPosts(held);
    assert.equal(posts.status, 200);
    const claims = JSON.parse(Buffer.from(held.credential.split(".")[1], "base64url"));
    assert.ok(claims.exp - claims.iat <= 600, "10 minutes by default");
  });

  it("refuses an account that isn't linked, even while someone else is subscribed", async () => {
    subscription("active");
    const other = await xrpc("com.atproto.server.createAccount", { body: { handle: "bobby.test", email: "bobby@test.com", password: "bobby-pass" } });
    const cred = await requestCredential(other);
    assert.equal(cred.status, 400);
  });
});
