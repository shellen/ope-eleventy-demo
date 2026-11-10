// ABOUTME: End-to-end tests: the real publisher, this License Server, and the reader's client library.
// ABOUTME: Builds the blog for test ports, starts both servers, and walks spec Appendix B plus the failure cases.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, generateDpopKey, pkce, decodeJwt } from "../../ope-reader/ope-client.js";
import { autoAuthorize } from "../../ope-reader/auto-consent.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LS = "http://localhost:4298";
const SITE = "http://localhost:8298";
const SCOPE = `${SITE}/posts/`;
const POST = `${SITE}/posts/002-protocol-economics/`;
const OTHER_POST = `${SITE}/posts/005-podcast-open-feeds/`;
const ITEM_POST = `${SITE}/posts/004-building-for-readers/`;
const REDIRECT = "http://127.0.0.1:9/callback"; // never contacted: autoAuthorize reads the redirect
const RS_SECRET = "flow-test-secret";

const procs = [];
let siteDir;
let contentFile;
const client = createClient();
let authServer;

async function waitFor(url) {
  for (let i = 0; i < 600; i++) { // up to a minute: wrangler dev takes a while to start
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`${url} did not start`);
}

// OPE_LS_ENTRY=test/netlify-shim.mjs runs the License Server through its Netlify Function.
function start(cwd, env, entry = "server.js") {
  const p = spawn(process.execPath, [entry], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"] });
  procs.push(p);
}

before(async () => {
  siteDir = mkdtempSync(join(tmpdir(), "ope-site-"));
  contentFile = `${siteDir}.content.json`; // full posts live outside the published site
  const env = { ...process.env, OPE_SITE_URL: SITE, OPE_LICENSE_SERVER: LS, OPE_CONTENT_FILE: contentFile };
  execFileSync(process.execPath, [join(ROOT, "ope-blog/node_modules/@11ty/eleventy/cmd.cjs"), "--quiet", `--output=${siteDir}`],
    { cwd: join(ROOT, "ope-blog"), env, stdio: "ignore" });
  start(join(ROOT, "ope-blog"), {
    PORT: "8298", OPE_SITE_URL: SITE, OPE_LICENSE_SERVER: LS, OPE_SITE_DIR: siteDir, OPE_CONTENT_FILE: contentFile,
    OPE_RS_CLIENT_ID: "ope-demo-blog", OPE_RS_CLIENT_SECRET: RS_SECRET,
  });
  start(join(ROOT, "ope-license-server"), {
    PORT: "4298", OPE_PROTECTED_RESOURCES: SCOPE,
    OPE_RS_CLIENT_ID: "ope-demo-blog", OPE_RS_CLIENT_SECRET: RS_SECRET, OPE_RS_PUBLISHER: `${SITE}/`,
  }, process.env.OPE_LS_ENTRY);
  await Promise.all([waitFor(SITE), waitFor(LS)]);
});

after(() => {
  for (const p of procs) p.kill();
  if (siteDir) {
    rmSync(siteDir, { recursive: true, force: true });
    rmSync(`${siteDir}.content.json`, { force: true });
  }
});

// One app install: registration, a DPoP key (or none), and an authorization for one resource.
async function connect({ account, choose, resource = POST, dpop = true, name = "Test Reader" }) {
  const app = await client.register(authServer, { clientName: name, redirectUri: REDIRECT });
  const key = dpop ? await generateDpopKey() : null;
  const { verifier, challenge } = await pkce();
  const url = client.authorizationUrl(authServer, {
    clientId: app.client_id, redirectUri: REDIRECT, resource, codeChallenge: challenge, state: "st",
  });
  const back = await autoAuthorize(url, { account, choose });
  if (back.error) return { app, key, back };
  assert.equal(back.state, "st");
  assert.equal(back.iss, LS);
  const tokens = await client.exchangeCode(authServer, {
    clientId: app.client_id, code: back.code, redirectUri: REDIRECT, codeVerifier: verifier, resource,
  }, key);
  return { app, key, back, tokens, verifier };
}

const introspect = (token, secret = RS_SECRET) => fetch(`${LS}/introspect`, {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(`ope-demo-blog:${secret}`).toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ token, resource: POST }),
});

describe("Discovery (spec §7, Appendix B.1)", () => {
  it("a gated post answers 402 naming its scope, and the metadata leads to this License Server", async () => {
    const found = await client.discover(POST);
    assert.equal(found.status, 402);
    assert.equal(found.scope, SCOPE);
    assert.deepEqual(found.challenges.map((c) => c.scheme), ["DPoP", "License"]);
    assert.equal(found.resourceMetadata.resource, SCOPE);
    assert.equal(found.authServer.issuer, LS);
    assert.deepEqual(found.authServer.protected_resources, [SCOPE]);
    authServer = found.authServer;
  });

  it("a post with its own Offers resolves to its per-URL metadata", async () => {
    const found = await client.discover(ITEM_POST);
    assert.equal(found.challenges[0].params.resource_metadata,
      `${SITE}/.well-known/oauth-protected-resource/posts/004-building-for-readers/`);
    assert.equal(found.challenges[0].params.ope_scope, undefined);
    assert.equal(found.resourceMetadata.resource, ITEM_POST);
    assert.ok(found.resourceMetadata.ope.offers.some((o) => o.id === "item-building-for-readers"));
  });

  it("publishes an ES256 key set", async () => {
    const { keys } = await (await fetch(`${LS}/jwks.json`)).json();
    assert.equal(keys[0].alg, "ES256");
    assert.equal(keys[0].d, undefined);
  });
});

describe("Registration (spec §8.2)", () => {
  it("refuses a plain-http redirect that isn't loopback", async () => {
    await assert.rejects(client.register(authServer, { clientName: "Bad", redirectUri: "http://evil.example/cb" }));
  });

  it("issues public clients only", async () => {
    const app = await client.register(authServer, { clientName: "Good", redirectUri: REDIRECT });
    assert.equal(app.token_endpoint_auth_method, "none");
    assert.equal(app.client_secret, undefined);
  });
});

describe("Subscribe and read (Appendix B.2–B.5)", () => {
  let alice;
  before(async () => { alice = await connect({ account: "alice", choose: "offer:monthly" }); });

  it("issues a DPoP-bound license+jwt covering the scope", () => {
    const { tokens, key } = alice;
    assert.equal(tokens.token_type, "DPoP");
    assert.equal(tokens.resource, SCOPE);
    const header = JSON.parse(Buffer.from(tokens.access_token.split(".")[0], "base64url"));
    assert.equal(header.typ, "license+jwt");
    assert.equal(header.alg, "ES256");
    const claims = decodeJwt(tokens.access_token);
    assert.equal(claims.iss, LS);
    assert.deepEqual(claims.aud, [SITE]);
    assert.equal(claims.cnf.jkt, key.jkt);
    assert.equal(claims.publisher, `${SITE}/`);
    assert.equal(claims.entitlement.coverage, "collection");
    assert.equal(claims.entitlement.type, "access");
    assert.match(claims.terms.sha256, /^[\w-]{43}$/);
    assert.ok(!claims.sub.includes("alice"), "subject must not reveal the account name");
  });

  it("reads the gated post, and another post in the same scope", async () => {
    for (const url of [POST, OTHER_POST]) {
      const r = await client.fetchAsset(url, alice.tokens, alice.key);
      assert.equal(r.status, 200, url);
      assert.ok(r.body.content_html.length > 500);
    }
  });

  it("refuses the token with someone else's DPoP key", async () => {
    const thief = await generateDpopKey();
    const r = await client.fetchAsset(POST, alice.tokens, thief);
    assert.equal(r.status, 401);
  });

  it("refuses the bound token presented under the License scheme", async () => {
    const r = await client.fetchAsset(POST, { ...alice.tokens, token_type: "License" }, null);
    assert.equal(r.status, 401);
  });

  it("refuses a code used twice, and a wrong PKCE verifier", async () => {
    await assert.rejects(client.exchangeCode(authServer, {
      clientId: alice.app.client_id, code: alice.back.code, redirectUri: REDIRECT, codeVerifier: alice.verifier,
    }, alice.key), /invalid_grant/);
    const app = await client.register(authServer, { clientName: "PKCE", redirectUri: REDIRECT });
    const { challenge } = await pkce();
    const url = client.authorizationUrl(authServer, { clientId: app.client_id, redirectUri: REDIRECT, resource: POST, codeChallenge: challenge, state: "st" });
    const back = await autoAuthorize(url, { account: "alice", choose: "approve" });
    await assert.rejects(client.exchangeCode(authServer, {
      clientId: app.client_id, code: back.code, redirectUri: REDIRECT, codeVerifier: "wrong",
    }, null), /PKCE/);
  });

  it("gives a second app the same pairwise subject without a second checkout (S2)", async () => {
    const second = await connect({ account: "alice", choose: "approve", name: "Other Reader", dpop: false });
    assert.equal(second.tokens.token_type, "License");
    assert.equal(decodeJwt(second.tokens.access_token).sub, decodeJwt(alice.tokens.access_token).sub);
    const r = await client.fetchAsset(POST, second.tokens, null);
    assert.equal(r.status, 200);
  });
});

describe("Refresh and revocation (spec §12)", () => {
  it("rotates refresh tokens, and a replayed one revokes the whole grant", async () => {
    const bob = await connect({ account: "bob", choose: "offer:annual" });
    const next = await client.refresh(authServer, { clientId: bob.app.client_id, refreshToken: bob.tokens.refresh_token }, bob.key);
    assert.notEqual(next.refresh_token, bob.tokens.refresh_token);
    assert.equal((await client.fetchAsset(POST, next, bob.key)).status, 200);

    await assert.rejects(
      client.refresh(authServer, { clientId: bob.app.client_id, refreshToken: bob.tokens.refresh_token }, bob.key),
      /reused/);
    const r = await client.fetchAsset(POST, next, bob.key);
    assert.equal(r.status, 401);
    await assert.rejects(
      client.refresh(authServer, { clientId: bob.app.client_id, refreshToken: next.refresh_token }, bob.key),
      /invalid_grant/);
  });

  it("refuses a refresh without the bound key's proof", async () => {
    const carol = await connect({ account: "carol", choose: "offer:monthly" });
    await assert.rejects(
      client.refresh(authServer, { clientId: carol.app.client_id, refreshToken: carol.tokens.refresh_token }, await generateDpopKey()),
      /bound key/);
  });

  it("revoking the refresh token stops the access token at the publisher", async () => {
    const dave = await connect({ account: "dave", choose: "offer:monthly" });
    assert.equal((await client.fetchAsset(POST, dave.tokens, dave.key)).status, 200);
    assert.equal(await client.revoke(authServer, { clientId: dave.app.client_id, token: dave.tokens.refresh_token }), 200);
    const r = await client.fetchAsset(POST, dave.tokens, dave.key);
    assert.equal(r.status, 401);
    assert.match(r.challenges[0].params.error_description, /client_revoked/);
  });
});

describe("Item purchases and refusals", () => {
  it("an item purchase covers that post only", async () => {
    const erin = await connect({ account: "erin", choose: "offer:item-building-for-readers", resource: ITEM_POST });
    const claims = decodeJwt(erin.tokens.access_token);
    assert.equal(claims.entitlement.coverage, "item");
    assert.equal(claims.resource, ITEM_POST);
    assert.equal((await client.fetchAsset(ITEM_POST, erin.tokens, erin.key)).status, 200);
    const other = await client.fetchAsset(POST, erin.tokens, erin.key);
    assert.equal(other.status, 403);
    assert.equal(other.challenges[0].params.error, "insufficient_scope");
  });

  it("approving without an Entitlement returns no_entitlement to the app", async () => {
    const { back } = await connect({ account: "frank", choose: "approve" });
    assert.equal(back.error, "no_entitlement");
  });

  it("denying returns access_denied", async () => {
    const { back } = await connect({ account: "frank", choose: "deny" });
    assert.equal(back.error, "access_denied");
  });

  it("refuses a resource this License Server doesn't issue for", async () => {
    const { back } = await connect({ account: "frank", choose: "approve", resource: `${SITE}/about/` });
    assert.equal(back.error, "invalid_target");
  });
});

describe("Introspection (spec §12.4)", () => {
  it("requires the Resource Server's credential", async () => {
    assert.equal((await introspect("x", "wrong")).status, 401);
  });

  it("answers with permitted for the resource asked about", async () => {
    const gina = await connect({ account: "gina", choose: "offer:monthly" });
    const body = await (await introspect(gina.tokens.access_token)).json();
    assert.equal(body.active, true);
    assert.equal(body.permitted, true);
    assert.equal(body.token_type, "DPoP");
  });
});
