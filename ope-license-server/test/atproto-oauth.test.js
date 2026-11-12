// ABOUTME: Tests for linking an atproto account by signing in with it (atproto-oauth.js).
// ABOUTME: Client metadata, and the checks on what the account's authorization server returns.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK } from "jose";
import { clientFor, clientMetadata, finishLink, resolveIdentity } from "../atproto-oauth.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Answer fetches from a table of URL → JSON body (or a function of the request).
function fakeNetwork(routes) {
  globalThis.fetch = async (url, init) => {
    const route = routes[String(url).split("?")[0]];
    if (!route) return new Response("not found", { status: 404 });
    const body = typeof route === "function" ? route(url, init) : route;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const AS = "https://auth.example";
const PDS = "https://pds.example";
const plc = (did, handle, pds) => ({ id: did, alsoKnownAs: [`at://${handle}`], service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }] });

async function txnFor(did, handle) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return { did, handle, issuer: AS, tokenEndpoint: `${AS}/oauth/token`, verifier: "v", dpopJwk: await exportJWK(privateKey), at: Date.now() };
}

describe("atproto OAuth client for account linking", () => {
  it("uses atproto's loopback client locally, and published metadata when deployed", () => {
    const local = clientFor("http://localhost:4000");
    assert.equal(local.redirectUri, "http://127.0.0.1:4000/account/atproto/callback");
    assert.ok(local.clientId.startsWith("http://localhost?"));
    assert.equal(new URL(local.clientId).searchParams.get("scope"), "atproto");

    const meta = clientMetadata("https://ls.example", "OPE License Server");
    assert.equal(meta.client_id, "https://ls.example/oauth/atproto-client-metadata.json");
    assert.deepEqual(meta.redirect_uris, ["https://ls.example/account/atproto/callback"]);
    assert.equal(meta.scope, "atproto", "identity only: no access to the account's data");
    assert.equal(meta.dpop_bound_access_tokens, true);
  });

  it("keeps a handle only if the DID document claims it back", async () => {
    process.env.OPE_ATPROTO_HANDLE_RESOLVER = "https://resolver.example";
    fakeNetwork({
      "https://resolver.example/xrpc/com.atproto.identity.resolveHandle": { did: "did:plc:ada" },
      "https://plc.directory/did:plc:ada": plc("did:plc:ada", "someone-else.test", PDS),
    });
    await assert.rejects(resolveIdentity("ada.test"), /does not claim the handle/);
    delete process.env.OPE_ATPROTO_HANDLE_RESOLVER;
  });

  it("links the DID in the token response", async () => {
    fakeNetwork({ [`${AS}/oauth/token`]: { sub: "did:plc:ada", scope: "atproto", token_type: "DPoP", access_token: "x" } });
    const linked = await finishLink({ issuer: "https://ls.example", txn: await txnFor("did:plc:ada", "ada.test"), query: { code: "c", iss: AS, state: "s" } });
    assert.deepEqual(linked, { did: "did:plc:ada", handle: "ada.test" });
  });

  it("refuses a response from another authorization server (RFC 9207 iss)", async () => {
    await assert.rejects(
      finishLink({ issuer: "https://ls.example", txn: await txnFor("did:plc:ada", "ada.test"), query: { code: "c", iss: "https://evil.example" } }),
      /different authorization server/,
    );
  });

  it("refuses a DID whose own PDS names a different authorization server", async () => {
    // The sign-in started for ada, but the server says someone else signed in: a DID it
    // has no authority over. Their PDS's authorization server is elsewhere.
    fakeNetwork({
      [`${AS}/oauth/token`]: { sub: "did:plc:victim", scope: "atproto", token_type: "DPoP", access_token: "x" },
      "https://plc.directory/did:plc:victim": plc("did:plc:victim", "victim.test", "https://other-pds.example"),
      "https://other-pds.example/.well-known/oauth-protected-resource": { authorization_servers: ["https://other-auth.example"] },
      "https://other-auth.example/.well-known/oauth-authorization-server": {
        issuer: "https://other-auth.example", pushed_authorization_request_endpoint: "x", token_endpoint: "y",
      },
    });
    await assert.rejects(
      finishLink({ issuer: "https://ls.example", txn: await txnFor("did:plc:ada", "ada.test"), query: { code: "c", iss: AS } }),
      /isn't served by the authorization server/,
    );
  });

  it("refuses a token without the atproto scope, or not DPoP-bound", async () => {
    fakeNetwork({ [`${AS}/oauth/token`]: { sub: "did:plc:ada", scope: "transition:generic", token_type: "DPoP" } });
    await assert.rejects(finishLink({ issuer: "https://ls.example", txn: await txnFor("did:plc:ada", "ada.test"), query: { code: "c", iss: AS } }), /atproto scope/);
    fakeNetwork({ [`${AS}/oauth/token`]: { sub: "did:plc:ada", scope: "atproto", token_type: "Bearer" } });
    await assert.rejects(finishLink({ issuer: "https://ls.example", txn: await txnFor("did:plc:ada", "ada.test"), query: { code: "c", iss: AS } }), /DPoP-bound/);
  });

  it("refuses a sign-in that took too long", async () => {
    const txn = { ...(await txnFor("did:plc:ada", "ada.test")), at: Date.now() - 11 * 60 * 1000 };
    await assert.rejects(finishLink({ issuer: "https://ls.example", txn, query: { code: "c", iss: AS } }), /took too long/);
  });
});
