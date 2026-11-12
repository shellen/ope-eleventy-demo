// ABOUTME: Links an atproto account to an OPE account by signing in with it (atproto OAuth).
// ABOUTME: Identity only (scope "atproto"): PAR, PKCE, DPoP, then checks who the PDS says signed in.

// The License Server is an atproto OAuth client here, not a server. A subscriber who
// wants to read a publisher's atproto space signs in with their atproto account; the
// License Server keeps the DID the account's own authorization server vouches for, and
// throws the tokens away. It never acts on the account.
//
// The steps follow the atproto OAuth profile:
//   handle → DID → PDS → the PDS's authorization server (RFC 9728, then RFC 8414)
//   PAR (RFC 9126) with PKCE and a DPoP proof, then the authorization redirect
//   code → token, with DPoP; the token response's `sub` is the account's DID
// and one check that matters most: the authorization server that issued the token must
// be the one the DID's own PDS names. Otherwise any server could claim any DID.

import { SignJWT, generateKeyPair, exportJWK, importJWK } from "jose";

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

const HANDLE_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

async function getJson(url, init) {
  const res = await fetch(url, { ...init, headers: { accept: "application/json", ...(init?.headers || {}) } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// ── Identity ──

// A handle's DID: the DNS TXT record _atproto.<handle> (over DNS-over-HTTPS, so it
// runs on Workers too), else https://<handle>/.well-known/atproto-did.
// OPE_ATPROTO_HANDLE_RESOLVER: an XRPC service to ask instead (a test network's PDS).
export async function resolveHandle(handle) {
  const override = process.env.OPE_ATPROTO_HANDLE_RESOLVER;
  if (override) {
    const r = await getJson(`${override.replace(/\/$/, "")}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
    return r.did;
  }
  const attempts = [
    async () => {
      const r = await getJson(`https://cloudflare-dns.com/dns-query?name=_atproto.${encodeURIComponent(handle)}&type=TXT`, { headers: { accept: "application/dns-json" } });
      const txt = (r.Answer || []).map((a) => String(a.data).replace(/^"|"$/g, "")).find((t) => t.startsWith("did="));
      if (!txt) throw new Error("no _atproto TXT record");
      return txt.slice(4);
    },
    async () => {
      const res = await fetch(`https://${handle}/.well-known/atproto-did`, { redirect: "error" });
      const did = res.ok ? (await res.text()).trim() : "";
      if (!did.startsWith("did:")) throw new Error("no /.well-known/atproto-did");
      return did;
    },
  ];
  for (const attempt of attempts) {
    try { return await attempt(); } catch { /* try the next way */ }
  }
  throw new Error(`could not resolve the handle ${handle}`);
}

export async function resolveDidDocument(did) {
  if (did.startsWith("did:plc:")) return getJson(`${(process.env.OPE_PLC_URL || "https://plc.directory").replace(/\/$/, "")}/${did}`);
  if (did.startsWith("did:web:")) return getJson(`https://${decodeURIComponent(did.slice(8))}/.well-known/did.json`);
  throw new Error(`unsupported DID method: ${did}`);
}

// { did, handle, pds } for a handle or a DID. The handle is kept only if the DID
// document claims it back (atproto's bidirectional check).
export async function resolveIdentity(input) {
  const value = String(input || "").trim().replace(/^@/, "").replace(/^at:\/\//, "").toLowerCase();
  let did, handle;
  if (value.startsWith("did:")) did = value;
  else if (HANDLE_RE.test(value)) { handle = value; did = await resolveHandle(value); }
  else throw new Error("enter a handle like you.bsky.social, or a DID");
  const doc = await resolveDidDocument(did);
  if (doc.id !== did) throw new Error("DID document does not match the DID");
  const claimed = (doc.alsoKnownAs || []).find((a) => a.startsWith("at://"))?.slice(5).toLowerCase();
  if (handle && claimed !== handle) throw new Error(`${did} does not claim the handle ${handle}`);
  const pds = (doc.service || []).find((s) => s.id === "#atproto_pds" || s.id === `${did}#atproto_pds`)?.serviceEndpoint;
  if (typeof pds !== "string") throw new Error(`${did} names no PDS`);
  return { did, handle: claimed || did, pds: pds.replace(/\/$/, "") };
}

// The authorization server a PDS names, and its metadata.
export async function authServerFor(pds) {
  const prm = await getJson(`${pds}/.well-known/oauth-protected-resource`);
  const issuer = prm.authorization_servers?.[0];
  if (!issuer) throw new Error(`${pds} names no authorization server`);
  const meta = await getJson(`${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  if (meta.issuer !== issuer) throw new Error("authorization server metadata names a different issuer");
  if (!meta.pushed_authorization_request_endpoint || !meta.token_endpoint) throw new Error("authorization server lacks PAR or a token endpoint");
  return meta;
}

// ── DPoP (RFC 9449) ──

async function dpopProof(key, { htm, htu, nonce }) {
  return new SignJWT({ jti: random(16), htm, htu, iat: Math.floor(Date.now() / 1000), ...(nonce ? { nonce } : {}) })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk })
    .sign(key.privateKey);
}

// POST a form with a DPoP proof, retrying once with the server's nonce (RFC 9449 §8).
async function dpopPost(url, form, key, state) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", DPoP: await dpopProof(key, { htm: "POST", htu: url, nonce: state.nonce }) },
      body: new URLSearchParams(form),
    });
    const nonce = res.headers.get("dpop-nonce");
    if (nonce) state.nonce = nonce;
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    if (body.error === "use_dpop_nonce" && nonce && attempt === 0) continue;
    throw new Error(`${url}: ${body.error || res.status}${body.error_description ? `: ${body.error_description}` : ""}`);
  }
}

// ── The client ──

// Client metadata for a deployed License Server. On a loopback issuer (local runs),
// atproto's development client is used instead: a client_id of http://localhost with
// the redirect URI in its query, and a 127.0.0.1 redirect.
export function clientFor(issuer) {
  const u = new URL(issuer);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (loopback) {
    const redirectUri = `http://127.0.0.1${u.port ? `:${u.port}` : ""}/account/atproto/callback`;
    return { loopback, redirectUri, clientId: `http://localhost?${new URLSearchParams({ redirect_uri: redirectUri, scope: "atproto" })}` };
  }
  const redirectUri = `${issuer}/account/atproto/callback`;
  return { loopback, redirectUri, clientId: `${issuer}/oauth/atproto-client-metadata.json` };
}

export function clientMetadata(issuer, clientName) {
  const { clientId, redirectUri } = clientFor(issuer);
  return {
    client_id: clientId,
    client_name: clientName,
    client_uri: issuer,
    redirect_uris: [redirectUri],
    scope: "atproto",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
    dpop_bound_access_tokens: true,
  };
}

// Begin signing in. Returns the URL to send the browser to and the transaction to keep
// (keyed by `state`) until the callback.
export async function startLink({ issuer, input }) {
  const { clientId, redirectUri } = clientFor(issuer);
  const identity = await resolveIdentity(input);
  const as = await authServerFor(identity.pds);
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const key = { publicJwk: await exportJWK(publicKey), privateKey };
  const verifier = random(32);
  const state = random(16);
  const dpop = {};
  const par = await dpopPost(as.pushed_authorization_request_endpoint, {
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "atproto",
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
    login_hint: identity.handle !== identity.did ? identity.handle : identity.did,
  }, key, dpop);
  const url = `${as.authorization_endpoint}?${new URLSearchParams({ client_id: clientId, request_uri: par.request_uri })}`;
  return {
    url,
    state,
    txn: {
      did: identity.did,
      handle: identity.handle,
      issuer: as.issuer,
      tokenEndpoint: as.token_endpoint,
      verifier,
      nonce: dpop.nonce,
      dpopJwk: await exportJWK(privateKey),
      at: Date.now(),
    },
  };
}

// Finish signing in: exchange the code and return the DID the authorization server
// vouches for, after checking that server is the one the DID's own PDS names.
export async function finishLink({ issuer, txn, query }) {
  if (Date.now() - txn.at > 10 * 60 * 1000) throw new Error("the sign-in took too long; try again");
  if (query.error) throw new Error(`${query.error}${query.error_description ? `: ${query.error_description}` : ""}`);
  if (query.iss !== txn.issuer) throw new Error("the response came from a different authorization server (RFC 9207)");
  const { clientId, redirectUri } = clientFor(issuer);
  const privateKey = await importJWK(txn.dpopJwk, "ES256");
  const { d, ...publicJwk } = txn.dpopJwk;
  const key = { publicJwk, privateKey };
  const dpop = { nonce: txn.nonce };
  const token = await dpopPost(txn.tokenEndpoint, {
    grant_type: "authorization_code",
    code: String(query.code || ""),
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: txn.verifier,
  }, key, dpop);
  const sub = token.sub;
  if (typeof sub !== "string" || !sub.startsWith("did:")) throw new Error("the token response has no DID");
  if (!String(token.scope || "").split(" ").includes("atproto")) throw new Error("the token lacks the atproto scope");
  if (token.token_type?.toLowerCase() !== "dpop") throw new Error("the token isn't DPoP-bound");
  // The account that signed in may differ from the one first typed (the sign-in page
  // lets the user switch). The typed DID's authorization server was found through its
  // own PDS when signing in began; for any other DID, check that again now.
  let handle = txn.handle;
  if (sub !== txn.did) {
    const identity = await resolveIdentity(sub);
    const as = await authServerFor(identity.pds);
    if (as.issuer !== txn.issuer) throw new Error(`${sub} isn't served by the authorization server that signed it in`);
    handle = identity.handle;
  }
  return { did: sub, handle };
}
