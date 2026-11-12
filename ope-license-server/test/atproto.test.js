// ABOUTME: Tests for the ATProto profile prototype: the License Server as a space's managing app.
// ABOUTME: Plays the space host, signing checkAccess requests with atproto service auth.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createServiceJwt } from "@atproto/xrpc-server";

const PORT = 4396;
const BASE = `http://localhost:${PORT}`;
const SCOPE = "http://localhost:8080/posts/";
const PUBLISHER = "did:plc:publisherxyz";
const SPACE = `at://${PUBLISHER}/space/com.example.blog.post/main`;

process.env.OPE_ISSUER = BASE;
process.env.PORT = String(PORT);
process.env.OPE_PROTECTED_RESOURCES = SCOPE;
process.env.OPE_MANAGED_SPACES = JSON.stringify([{ space: SPACE, resource: SCOPE }]);

let server, lsApp, publisherKey, strangerKey;

const ALICE = { did: "did:plc:alicereader", handle: "alice.test" };
function seed({ aliceState = "active" } = {}) {
  lsApp.importState({
    maps: {
      entitlements: [["alice", [{ id: "ent_1", resource: SCOPE, coverage: "collection", state: aliceState, publisher: "http://localhost:8080/" }]]],
      atprotoLinks: [["alice", ALICE]],
    },
  });
}

async function ask({ repo = ALICE.did, space = SPACE, key = publisherKey, iss = PUBLISHER, lxm = "com.atproto.managedspace.checkAccess", aud, param = "repo", auth = true } = {}) {
  const method = lxm.endsWith("checkUserAccess") ? "checkUserAccess" : "checkAccess";
  const headers = {};
  if (auth) {
    const jwt = await createServiceJwt({ iss, aud: aud ?? lsApp.spaceManager.did, lxm, keypair: key });
    headers.authorization = `Bearer ${jwt}`;
  }
  const url = `${BASE}/xrpc/com.atproto.managedspace.${method}?space=${encodeURIComponent(space)}&${param}=${encodeURIComponent(repo)}`;
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  publisherKey = await Secp256k1Keypair.create();
  strangerKey = await Secp256k1Keypair.create();
  lsApp = await import("../app.js");
  // Stand in for DID resolution: each test DID's atproto signing key.
  lsApp.setAtprotoKeyResolver(async (did) => ({ [PUBLISHER]: publisherKey.did(), "did:plc:stranger": strangerKey.did() })[did] ?? null);
  server = lsApp.app.listen(PORT);
  await new Promise((r) => server.once("listening", r));
});
after(() => server?.close());

describe("ATProto profile prototype: License Server as a space's managing app", () => {
  it("publishes a did:web document naming its space-manager service", async () => {
    const doc = await (await fetch(`${BASE}/.well-known/did.json`)).json();
    assert.equal(doc.id, "did:web:localhost%3A4396");
    assert.deepEqual(doc.service, [{ id: "#ope_space_manager", type: "OpeSpaceManager", serviceEndpoint: BASE }]);
    assert.equal(lsApp.spaceManager.managingApp, "did:web:localhost%3A4396#ope_space_manager");
  });

  it("lets a subscriber with a linked account read, and never write", async () => {
    seed();
    const r = await ask();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { read: true, write: false });
  });

  it("refuses an account with no link", async () => {
    seed();
    assert.deepEqual((await ask({ repo: "did:plc:someoneelse" })).body, { read: false, write: false });
  });

  it("refuses once the subscription has ended", async () => {
    seed({ aliceState: "ended" });
    assert.deepEqual((await ask()).body, { read: false, write: false });
  });

  it("answers no for a space it doesn't manage", async () => {
    seed();
    const other = `at://${PUBLISHER}/space/com.example.blog.post/other`;
    assert.deepEqual((await ask({ space: other })).body, { read: false, write: false });
  });

  it("answers the published alpha's checkUserAccess, one access level at a time", async () => {
    seed();
    const read = await ask({ lxm: "com.atproto.managedspace.checkUserAccess", param: "user" });
    assert.deepEqual(read.body, { authorized: true });
    seed({ aliceState: "ended" });
    assert.deepEqual((await ask({ lxm: "com.atproto.managedspace.checkUserAccess", param: "user" })).body, { authorized: false });
  });

  it("accepts a request addressed to the did#service reference, as a space host sends it", async () => {
    seed();
    const r = await ask({ aud: lsApp.spaceManager.managingApp });
    assert.deepEqual(r.body, { read: true, write: false });
  });

  it("refuses a request signed by anyone but the space's authority", async () => {
    seed();
    const r = await ask({ key: strangerKey, iss: "did:plc:stranger" });
    assert.equal(r.status, 403);
  });

  it("refuses a forged signature, a token for another method or audience, and no token", async () => {
    seed();
    assert.equal((await ask({ key: strangerKey })).status, 401, "wrong key for the issuer");
    assert.equal((await ask({ lxm: "com.atproto.space.getRecord" })).status, 401, "other method");
    assert.equal((await ask({ aud: "did:web:elsewhere.example" })).status, 401, "other audience");
    assert.equal((await ask({ auth: false })).status, 401, "no token");
  });

  it("requires a space-ref, and a DID when a repo is given", async () => {
    seed();
    assert.equal((await ask({ space: "not-a-space" })).status, 400);
    assert.equal((await ask({ repo: "alice.test" })).status, 400);
  });

  it("gives an anonymous read (no repo) no access", async () => {
    seed();
    const { status, body } = await ask({ repo: "" });
    assert.equal(status, 200);
    assert.deepEqual(body, { read: false, write: false });
  });

  it("refuses to finish a link in a browser signed in as a different account", async () => {
    seed();
    const saved = lsApp.exportState();
    saved.maps.sessions = [["sid_mallory", "mallory"]];
    saved.maps.atprotoTxns = [["state1", { account: "alice", did: "did:plc:x", at: Date.now() }]];
    lsApp.importState(saved);
    const res = await fetch(`${BASE}/account/atproto/callback?state=state1&code=c&iss=x`, { headers: { cookie: "ope_ls_session=sid_mallory" }, redirect: "manual" });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location")), /started from a different account/);
    assert.deepEqual(lsApp.exportState().maps.atprotoLinks, [["alice", ALICE]], "links unchanged");
  });

  it("refuses an unknown or replayed sign-in", async () => {
    seed();
    const res = await fetch(`${BASE}/account/atproto/callback?state=nope&code=c`, { redirect: "manual" });
    assert.match(decodeURIComponent(res.headers.get("location")), /unknown or expired/);
  });

  it("saves account links with the rest of the state", () => {
    seed();
    const links = lsApp.exportState().maps.atprotoLinks;
    assert.deepEqual(links, [["alice", ALICE]]);
  });
});
