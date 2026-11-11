// ABOUTME: Integration test: the License Server as the managing app of a space on Bluesky's own
// ABOUTME: spaces-alpha PDS, run in-process (@atproto/dev-env). Not mocked: the PDS calls our server.

// A publisher's space under the `managedspace` policy names this License Server as its
// managing app. When a reader asks the PDS for a space credential, the PDS resolves our
// did:web document and calls our checkUserAccess with service auth signed by the
// publisher's key. We answer from the reader's OPE subscription.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import { P256Keypair } from "@atproto/crypto";

const LS_PORT = 4390;
const SCOPE = "http://localhost:8080/posts/";
const SPACE_TYPE = "com.example.group"; // the space type Bluesky's own space tests use
const SKEY = "subscribers";

let network, pds, publisher, ada, space, ls, server;
const lsCalls = [];

async function xrpc(method, { body, params, token, base }) {
  const url = new URL(`${base || pds.url}/xrpc/${method}`);
  if (params) url.search = new URLSearchParams(params);
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
  return xrpc("com.atproto.space.getSpaceCredential", { body: { space, credentialKid: key.did(), delegationToken: delegation.token } });
}

function subscription(state) {
  ls.importState({
    maps: {
      entitlements: [["ada", [{ id: "ent_1", resource: SCOPE, coverage: "collection", state, publisher: "http://localhost:8080/" }]]],
      atprotoLinks: [["ada", { did: ada.did, handle: "ada.test" }]],
    },
  });
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
  process.env.OPE_MANAGED_SPACES = JSON.stringify([{ space, resource: SCOPE }]);
  ls = await import("../app.js");
  server = ls.app.listen(LS_PORT);
  server.on("request", (req) => lsCalls.push(req.url));
  await new Promise((r) => server.once("listening", r));
});

after(async () => {
  server?.close();
  await network?.close();
});

describe("A space on Bluesky's spaces-alpha PDS, managed by the License Server", () => {
  it("creates a managedspace naming the License Server as its managing app", async () => {
    const created = await xrpc("com.atproto.space.createSpace", {
      token: publisher.accessJwt,
      body: { spaceType: SPACE_TYPE, skey: SKEY, policy: { $type: "com.atproto.managedspace.policy", managingApp: ls.spaceManager.managingApp } },
    });
    assert.equal(created.status, 200, JSON.stringify(created));
    assert.equal(created.uri, space);
  });

  it("refuses a reader with no subscription: the PDS asked us, and we said no", async () => {
    lsCalls.length = 0;
    const cred = await requestCredential(ada);
    assert.equal(cred.status, 400);
    assert.equal(cred.error, "SpaceNotFound", "a refused reader can't even see the space");
    assert.ok(lsCalls.some((u) => u.includes("com.atproto.managedspace.checkUserAccess")), "the PDS consulted the License Server");
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
    assert.ok(claims.cnf?.kid, "bound to the app's key");
    assert.ok(claims.exp - claims.iat <= 3600, "short-lived: within the hour OPE allows");
  });

  it("refuses again once the subscription is cancelled", async () => {
    subscription("ended");
    const cred = await requestCredential(ada);
    assert.equal(cred.status, 400);
    assert.equal(cred.error, "SpaceNotFound");
  });

  it("refuses an account that isn't linked, even while someone else is subscribed", async () => {
    subscription("active");
    const other = await xrpc("com.atproto.server.createAccount", { body: { handle: "bobby.test", email: "bobby@test.com", password: "bobby-pass" } });
    const cred = await requestCredential(other);
    assert.equal(cred.status, 400);
  });
});
