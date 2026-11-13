// ABOUTME: Integration test: a multi-user atproto app syncs a managed space once, then checks
// ABOUTME: each of its users with an OPE License Token before showing them the space's posts.

// Proposal 0016 says a space credential admits an *app*, not each reader: the app may
// sync with any one user's session, and must decide which of its users see what. This
// test runs that on Bluesky's spaces-alpha PDS, with the real License Server:
//
//   ada    subscribes and has linked an atproto account. That session lets the app sync.
//   bobby  uses the same app and has no subscription. The app holds the posts, but that
//          view stays locked: the License Server won't issue bobby a token.
//   carol  subscribes from inside the app, and never links an atproto account. The view
//          unlocks: the per-user check is plain OPE, with no atproto identity needed.
//
// Then ada cancels: the app can no longer sync with that session, and ada's own view locks
// at the next check, while carol's stays open.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import express from "express";
import { createSpaceApp } from "../../atproto-example/space-app.mjs";
import { autoAuthorize } from "../../ope-reader/auto-consent.js";

const LS_PORT = 4394;
const PUB_PORT = 4395;
const PUB = `http://localhost:${PUB_PORT}`;
const SCOPE = `${PUB}/posts/`;
const SPACE_TYPE = "com.example.group";
const POSTS = "com.example.post";

let network, pds, publisher, ada, bobby, space, ls, lsServer, pubServer, app;

async function xrpc(method, { body, params, token }) {
  const url = new URL(`${pds.url}/xrpc/${method}`);
  if (params) url.search = new URLSearchParams(params);
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}

// Sign in to the License Server's account page as `account` and cancel a subscription,
// as the subscriber would.
async function cancelAt(account, id) {
  const login = await fetch(`${ls.ISSUER}/login`, { method: "POST", body: new URLSearchParams({ account }), redirect: "manual" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await fetch(`${ls.ISSUER}/account/cancel`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ id }), redirect: "manual" });
}

before(async () => {
  network = await TestNetworkNoAppView.create({});
  pds = network.pds;
  const account = (name) => xrpc("com.atproto.server.createAccount", { body: { handle: `${name}.test`, email: `${name}@test.com`, password: `${name}-pass` } });
  publisher = await account("writer");
  ada = await account("adaline");
  bobby = await account("bobbie");
  space = `at://${publisher.did}/space/${SPACE_TYPE}/paid`;

  // The publisher's OPE metadata for the Asset the space stands for (RFC 9728), and its Terms.
  const pub = express();
  pub.get("/.well-known/oauth-protected-resource/posts/", (_req, res) => res.json({
    resource: SCOPE,
    authorization_servers: [`http://localhost:${LS_PORT}`],
    ope: {
      publisher: `${PUB}/`,
      offers: [{ id: "monthly", name: "Monthly", payment: { type: "subscription", amount: "5.00", currency: "USD", period: "P1M" }, terms: { url: `${PUB}/terms/` }, entitlement_types: ["access"] }],
    },
  }));
  pub.get("/terms/", (_req, res) => res.type("text/plain").send("Personal use."));
  pubServer = pub.listen(PUB_PORT);

  process.env.OPE_ISSUER = `http://localhost:${LS_PORT}`;
  process.env.PORT = String(LS_PORT);
  process.env.OPE_PROTECTED_RESOURCES = SCOPE;
  process.env.OPE_PLC_URL = network.plc.url;
  process.env.OPE_MANAGED_SPACES = JSON.stringify([{ space, resource: SCOPE }]);
  ls = await import("../app.js");
  lsServer = ls.app.listen(LS_PORT);
  await new Promise((r) => lsServer.once("listening", r));

  // ada already subscribes, and has linked an atproto account (spaces.test.js covers
  // linking by signing in; here it's set directly).
  ls.importState({
    maps: {
      entitlements: [["ada", [{ id: "ent_ada", resource: SCOPE, coverage: "collection", state: "active", publisher: `${PUB}/` }]]],
      atprotoLinks: [["ada", { did: ada.did, handle: "adaline.test" }]],
    },
  });

  // The publisher's paid space, managed by the License Server, with two posts in it.
  const created = await xrpc("com.atproto.space.createSpace", {
    token: publisher.accessJwt,
    body: { spaceType: SPACE_TYPE, skey: "paid", policy: { $type: "com.atproto.managedspace.policy", managingApp: ls.spaceManager.managingApp } },
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  for (const text of ["Paid post one", "Paid post two"]) {
    const w = await xrpc("com.atproto.space.createRecord", {
      token: publisher.accessJwt,
      body: { space, repo: publisher.did, collection: POSTS, validate: false, record: { $type: POSTS, text, createdAt: new Date().toISOString() } },
    });
    assert.equal(w.status, 200, JSON.stringify(w));
  }

  // The app. Its users go through the License Server's authorization page; the test
  // drives the demo forms (signing in as the user's License Server account, and choosing
  // what that user would choose).
  const choices = { ada: "approve", bobby: "approve", carol: "offer:monthly" };
  app = createSpaceApp({
    space,
    spaceHost: pds.url,
    asset: SCOPE,
    collection: POSTS,
    clientName: "A multi-user atproto app",
    redirectUri: "http://127.0.0.1:4396/callback",
    authorize: (url, user) => autoAuthorize(url, { account: user, choose: choices[user] }),
    recheckSeconds: 0, // re-check on every view, so the test needn't wait
  });
});

after(async () => {
  lsServer?.close();
  pubServer?.close();
  await network?.close();
});

describe("A multi-user app: the space admits the app, and OPE checks each user", () => {
  it("syncs the space once, acting for a subscriber whose account is linked", async () => {
    const synced = await app.sync({ pds: pds.url, accessJwt: ada.accessJwt });
    assert.deepEqual(synced, { posts: 2, repos: 1 });
  });

  it("refuses to sync for a user without a subscription", async () => {
    await assert.rejects(app.sync({ pds: pds.url, accessJwt: bobby.accessJwt }), /SpaceNotFound/);
    assert.equal(app.posts.length, 2, "what was synced before stays");
  });

  it("shows nothing to a user until they connect a subscription", async () => {
    const v = await app.view("ada");
    assert.equal(v.locked, true);
    assert.equal(v.reason, "not connected");
  });

  it("shows the posts to a subscriber once they connect their subscription", async () => {
    assert.deepEqual(await app.connect("ada"), { connected: true });
    const v = await app.view("ada");
    assert.equal(v.locked, false);
    assert.deepEqual(v.posts.map((p) => p.text).sort(), ["Paid post one", "Paid post two"]);
  });

  it("keeps them from another user of the same app who has no subscription", async () => {
    const connected = await app.connect("bobby");
    assert.deepEqual(connected, { connected: false, reason: "no_entitlement" });
    const v = await app.view("bobby");
    assert.equal(v.locked, true, "the app holds the posts, but bobby doesn't see them");
    assert.equal(v.posts, undefined);
  });

  it("shows them to a user who subscribes from the app, without linking any atproto account", async () => {
    assert.deepEqual(await app.connect("carol"), { connected: true });
    assert.equal((await app.view("carol")).locked, false);
    assert.equal(ls.exportState().maps.atprotoLinks.length, 1, "only ada has linked an account");
  });

  it("locks a subscriber's view at the next check once they cancel, and leaves others open", async () => {
    await cancelAt("ada", "ent_ada");
    const v = await app.view("ada");
    assert.equal(v.locked, true);
    assert.equal(v.reason, "invalid_grant", "the License Server refused to refresh their token");
    assert.equal((await app.view("carol")).locked, false, "carol holds a subscription of their own");
  });

  it("can no longer sync with the cancelled subscriber's session", async () => {
    await assert.rejects(app.sync({ pds: pds.url, accessJwt: ada.accessJwt }), /SpaceNotFound/);
  });
});
