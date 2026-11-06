// ABOUTME: Tests for the publisher's OPE v0.2 Resource Server checks (spec §11.2, §16 vectors).
// ABOUTME: A fake License Server signs tokens with a real ES256 key and answers introspection.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { SignJWT, generateKeyPair, exportJWK, calculateJwkThumbprint } from "jose";

const LS_PORT = 4199;
const SITE_PORT = 8199;
const ISSUER = `http://localhost:${LS_PORT}`;
const SITE = `http://localhost:${SITE_PORT}`;
const SCOPE = `${SITE}/posts/`;
const POST = `${SITE}/posts/002-protocol-economics/`;
const OTHER_POST = `${SITE}/posts/005-podcast-open-feeds/`;

process.env.OPE_SITE_URL = SITE;
process.env.OPE_LICENSE_SERVER = ISSUER;
process.env.PORT = String(SITE_PORT);
process.env.OPE_RS_CLIENT_SECRET = "test-secret";

let lsServer, siteServer, signingKey, kid, clientKey, clientJwk, clientJkt;
const revoked = new Map(); // jti → reason

before(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signingKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  kid = "test-key";

  const ls = express();
  ls.use(express.urlencoded({ extended: false }));
  ls.get("/.well-known/oauth-authorization-server", (_req, res) => res.json({
    issuer: ISSUER,
    jwks_uri: `${ISSUER}/jwks.json`,
    introspection_endpoint: `${ISSUER}/introspect`,
  }));
  ls.get("/jwks.json", (_req, res) => res.json({ keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] }));
  ls.post("/introspect", (req, res) => {
    if (req.headers.authorization !== "Basic " + Buffer.from("ope-demo-blog:test-secret").toString("base64")) {
      return res.status(401).json({ error: "invalid_client" });
    }
    const jti = JSON.parse(Buffer.from(req.body.token.split(".")[1], "base64url")).jti;
    if (revoked.has(jti)) return res.json({ active: false, revocation_reason: revoked.get(jti) });
    res.json({ active: true, permitted: true });
  });
  lsServer = ls.listen(LS_PORT);

  const client = await generateKeyPair("ES256", { extractable: true });
  clientKey = client.privateKey;
  clientJwk = await exportJWK(client.publicKey);
  clientJkt = await calculateJwkThumbprint(clientJwk, "sha256");

  ({ server: siteServer } = await import("../server.js"));
  await new Promise((r) => setTimeout(r, 200));
});

after(() => {
  lsServer?.close();
  siteServer?.close();
});

// A License Token, valid by default; overrides change claims or the header.
async function token(overrides = {}, { typ = "license+jwt", key = signingKey, iss = ISSUER, exp = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: "s_test",
    client_id: "test-client",
    aud: [SITE],
    resource: SCOPE,
    publisher: `${SITE}/`,
    terms: { url: `${SITE}/terms/`, sha256: "x" },
    entitlement: { type: "access", coverage: "collection", duration: "recurring", source: "direct" },
    cnf: { jkt: clientJkt },
    ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", typ, kid })
    .setIssuer(iss)
    .setIssuedAt(now)
    .setExpirationTime(now + exp)
    .setJti(randomUUID())
    .sign(key);
}

async function proof(accessToken, { method = "GET", htu = POST, key = clientKey, jwk = clientJwk } = {}) {
  return new SignJWT({
    htm: method,
    htu,
    ath: createHash("sha256").update(accessToken).digest("base64url"),
  })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
    .setIssuedAt()
    .setJti(randomUUID())
    .sign(key);
}

async function get(url, headers = {}) {
  return fetch(url, { headers, redirect: "manual" });
}

async function dpopGet(url, tok, opts = {}) {
  return get(url, { Authorization: `DPoP ${tok}`, DPoP: await proof(tok, { htu: url, ...opts }), ...(opts.headers || {}) });
}

// Raw request, so the path reaches the server exactly as written (fetch would normalize it).
function rawGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "localhost", port: SITE_PORT, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

describe("discovery", () => {
  it("serves scope metadata as JSON, readable from any origin", async () => {
    const res = await get(`${SITE}/.well-known/oauth-protected-resource/posts/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const doc = await res.json();
    assert.equal(doc.ope.version, "0.2");
    assert.ok(doc.authorization_servers.length > 0);
  });

  it("serves the JSON Feed with feed-level Offers", async () => {
    const feed = await (await get(`${SITE}/feed.json`)).json();
    assert.ok(feed._ope.offers.length >= 1);
    assert.equal(feed._ope.about, "https://feedspec.org/ope/ns/0.2");
  });
});

describe("requests without a usable token", () => {
  it("answer 402 with an ope_scope challenge and no error code", async () => {
    const res = await get(POST);
    assert.equal(res.status, 402);
    const www = res.headers.get("www-authenticate");
    assert.match(www, /DPoP/);
    assert.match(www, new RegExp(`ope_scope="${SCOPE}"`));
    assert.doesNotMatch(www, /error=/);
    assert.match(await res.text(), /gated-notice/);
  });

  it("treat a Bearer token as no credentials (spec §14 downgrade)", async () => {
    const res = await get(POST, { Authorization: `Bearer ${await token()}` });
    assert.equal(res.status, 402);
  });

  it("leave free posts alone", async () => {
    const res = await get(`${SITE}/posts/001-why-feeds-matter/`);
    assert.equal(res.status, 200);
  });
});

describe("a valid DPoP-bound License Token", () => {
  it("unlocks the full post", async () => {
    const res = await dpopGet(POST, await token());
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Unlocked with OPE/);
  });

  it("returns JSON to apps that ask for it", async () => {
    const res = await dpopGet(POST, await token(), { headers: { Accept: "application/json" } });
    const body = await res.json();
    assert.equal(body.url, POST);
    assert.equal(body.subject, "s_test");
  });

  it("covers every post in its collection scope", async () => {
    assert.equal((await dpopGet(OTHER_POST, await token())).status, 200);
  });
});

describe("token checks (spec §16 vectors)", () => {
  const cases = [
    ["wrong typ (an at+jwt access token)", () => token({}, { typ: "at+jwt" }), 401, "invalid_token"],
    ["issuer not listed in our metadata", () => token({}, { iss: "http://localhost:4999" }), 401, "invalid_token"],
    ["wrong audience", () => token({ aud: ["https://elsewhere.example"] }), 401, "invalid_token"],
    ["expired", () => token({}, { exp: -60 }), 401, "invalid_token"],
    ["another publisher", () => token({ publisher: "https://elsewhere.example/" }), 403, "insufficient_scope"],
    ["an item token for a different post", () => token({ resource: OTHER_POST, entitlement: { type: "access", coverage: "item" } }), 403, "insufficient_scope"],
    ["a status-only Entitlement", () => token({ entitlement: { type: "status", coverage: "collection", kind: "ad-free" } }), 403, "no_entitlement"],
    ["a rental that has ended", () => token({ entitlement: { type: "access", coverage: "collection", duration: "rental", rental_expires_at: 1 } }), 403, "no_entitlement"],
  ];
  for (const [name, make, status, error] of cases) {
    it(`refuses ${name}`, async () => {
      const res = await dpopGet(POST, await make());
      assert.equal(res.status, status);
      assert.match(res.headers.get("www-authenticate"), new RegExp(`error="${error}"`));
    });
  }

  it("refuses a bound token presented under the License scheme", async () => {
    const res = await get(POST, { Authorization: `License ${await token()}` });
    assert.equal(res.status, 401);
  });

  it("accepts an unbound token under the License scheme", async () => {
    const res = await get(POST, { Authorization: `License ${await token({ cnf: undefined })}` });
    assert.equal(res.status, 200);
  });

  it("refuses a DPoP proof made with a different key", async () => {
    const other = await generateKeyPair("ES256", { extractable: true });
    const tok = await token();
    const res = await dpopGet(POST, tok, { key: other.privateKey, jwk: await exportJWK(other.publicKey) });
    assert.equal(res.status, 401);
  });

  it("refuses a replayed DPoP proof", async () => {
    const tok = await token();
    const p = await proof(tok);
    assert.equal((await get(POST, { Authorization: `DPoP ${tok}`, DPoP: p })).status, 200);
    assert.equal((await get(POST, { Authorization: `DPoP ${tok}`, DPoP: p })).status, 401);
  });

  it("refuses a revoked token, reporting the reason", async () => {
    const tok = await token();
    revoked.set(JSON.parse(Buffer.from(tok.split(".")[1], "base64url")).jti, "entitlement_ended");
    const res = await dpopGet(POST, tok);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /entitlement_ended/);
  });
});

describe("request normalization (spec §5.3)", () => {
  it("never serves full posts directly", async () => {
    assert.equal((await rawGet("/_ope/full/posts/002-protocol-economics/index.html")).status, 404);
  });

  it("resolves dot-segments before routing", async () => {
    const res = await rawGet("/posts/x/../../_ope/full/posts/002-protocol-economics/index.html");
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.body, /Unlocked with OPE/);
  });

  it("decodes percent-encoded unreserved characters before routing", async () => {
    const res = await rawGet("/%5Fope/full/posts/002-protocol-economics/index.html");
    assert.equal(res.status, 404);
  });

  it("gates a dot-segment path that resolves to a gated post", async () => {
    assert.equal((await rawGet("/posts/x/../002-protocol-economics/")).status, 402);
  });

  it("refuses encoded path separators", async () => {
    assert.equal((await rawGet("/posts%2F002-protocol-economics/")).status, 400);
  });
});
