// ABOUTME: A zero-dependency OPE v0.2 client: discovery, registration, PKCE, DPoP, tokens, fetching.
// ABOUTME: Uses only fetch and WebCrypto, so the same file runs in Node 20+ (CLI) and in browsers (web reader).

// Spec: https://feedspec.org/ope/spec/0.2/ (Appendix B walks through these steps in order)

const enc = new TextEncoder();

// ── Encoding helpers ────────────────────────────────────────────────

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlJson = (obj) => b64url(enc.encode(JSON.stringify(obj)));
const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

// Decode a JWT's payload without verifying it: apps only read their own tokens.
export function decodeJwt(jwt) {
  const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(escape(atob(part))));
}

// ── Challenges (spec §11.4) ─────────────────────────────────────────
// 'DPoP algs="ES256", ope_scope="…", License ope_scope="…"' → [{ scheme, params }]

export function parseChallenges(header) {
  const text = Array.isArray(header) ? header.join(", ") : header || "";
  const out = [];
  // Bare tokens start a challenge; name="value" pairs belong to the current one.
  for (const [, name, value] of text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
    if (value === undefined) out.push({ scheme: name, params: {} });
    else if (out.length) out[out.length - 1].params[name] = value;
  }
  return out;
}

// RFC 9728 §3.1: insert the well-known segment between host and path.
export function metadataUrl(identifier) {
  const u = new URL(identifier);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`;
}

// The Asset identifier: no query or fragment (spec §5.2). Also DPoP's htu.
export const assetId = (url) => { const u = new URL(url); return u.origin + u.pathname; };

// ── DPoP (RFC 9449) ─────────────────────────────────────────────────

// One key pair per app install. The private key never leaves WebCrypto.
export async function generateDpopKey() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", publicKey);
  const publicJwk = { kty, crv, x, y };
  // RFC 7638 thumbprint: required members in lexicographic order.
  const jkt = b64url(await sha256(JSON.stringify({ crv, kty, x, y })));
  return { privateKey, publicJwk, jkt };
}

// A proof for one request. ath binds it to the access token being presented.
export async function dpopProof(key, htm, htu, accessToken) {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk };
  const payload = {
    jti: randomString(16),
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    ...(accessToken ? { ath: b64url(await sha256(accessToken)) } : {}),
  };
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  // WebCrypto's ECDSA output is already the raw r||s form JWS uses.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

// ── PKCE (RFC 7636) ─────────────────────────────────────────────────

export async function pkce() {
  const verifier = randomString(32);
  return { verifier, challenge: b64url(await sha256(verifier)) };
}

// ── The client ──────────────────────────────────────────────────────
// options.fetch lets the web reader route publisher requests through its proxy.

export function createClient(options = {}) {
  const fetchPublisher = options.fetchPublisher || ((url, init) => fetch(url, init));
  const log = options.log || (() => {});

  async function json(res) {
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`${res.status}: not JSON: ${text.slice(0, 120)}`); }
  }

  // Step 1 (spec §7, Appendix B.1): ask for the Asset with no credentials. A 402
  // says it's for sale and names its scope; the metadata says who sells it.
  async function discover(assetUrl) {
    const asset = assetId(assetUrl);
    const res = await fetchPublisher(asset, { headers: { Accept: "application/json" } });
    const challenges = parseChallenges(res.headers.get("www-authenticate"));
    const scope = challenges.map((c) => c.params.ope_scope).find(Boolean);
    log("discover", { status: res.status, challenges });
    if (res.status !== 402 && res.status !== 401) return { asset, status: res.status, free: res.ok };

    // Follow the challenge to the metadata (spec §7.1). Each document must name,
    // as its resource, the identifier that led to it, or it is discarded.
    const pointer = challenges.map((c) => c.params.resource_metadata).find(Boolean);
    const candidates = [];
    if (pointer) candidates.push([pointer, asset]);
    if (scope && new URL(scope).origin === new URL(asset).origin && asset.startsWith(scope)) {
      candidates.push([metadataUrl(scope), scope]); // built from the scope, never taken from elsewhere
    }
    if (!candidates.length) candidates.push([metadataUrl(asset), asset]);
    let resourceMetadata = null;
    for (const [url, id] of candidates) {
      const r = await fetchPublisher(url, {});
      if (!r.ok) continue;
      const doc = await json(r);
      if (doc.resource === id) { resourceMetadata = doc; break; }
    }
    if (!resourceMetadata || !resourceMetadata.ope) throw new Error("no OPE metadata found for this Asset");
    const issuer = resourceMetadata.authorization_servers[0];
    const asRes = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
    const authServer = await json(asRes);
    if (authServer.issuer !== issuer) throw new Error("License Server metadata issuer mismatch");
    return { asset, status: res.status, scope, challenges, resourceMetadata, authServer };
  }

  // Step 2 (spec §8.2): Dynamic Client Registration, once per install.
  async function register(authServer, { clientName, redirectUri }) {
    const res = await fetch(authServer.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri] }),
    });
    const body = await json(res);
    if (!res.ok) throw new Error(`registration failed: ${body.error_description || body.error}`);
    return body;
  }

  // Step 3 (spec §8.1): the authorization request, for exactly one resource.
  function authorizationUrl(authServer, { clientId, redirectUri, resource, codeChallenge, state }) {
    const u = new URL(authServer.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      resource,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    }).toString();
    return u.href;
  }

  async function tokenRequest(authServer, params, dpopKey) {
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    if (dpopKey) headers.DPoP = await dpopProof(dpopKey, "POST", authServer.token_endpoint);
    // Leave out parameters the caller didn't give (resource is optional on exchange).
    const body = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
    const res = await fetch(authServer.token_endpoint, { method: "POST", headers, body });
    const answer = await json(res);
    if (!res.ok) {
      const err = new Error(`${answer.error}: ${answer.error_description || ""}`);
      err.oauth = answer;
      throw err;
    }
    return answer;
  }

  // Step 4 (spec §8.5): exchange the code. With a DPoP key the token is bound to it.
  function exchangeCode(authServer, { clientId, code, redirectUri, codeVerifier, resource }, dpopKey) {
    return tokenRequest(authServer, {
      grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri,
      code_verifier: codeVerifier, resource,
    }, dpopKey);
  }

  // Spec §12.1: each refresh returns a new refresh token; the old one is spent.
  function refresh(authServer, { clientId, refreshToken }, dpopKey) {
    return tokenRequest(authServer, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }, dpopKey);
  }

  // Step 5 (spec §11): present the token at the Asset's own URL.
  async function fetchAsset(url, tokens, dpopKey, { accept = "application/json" } = {}) {
    const headers = { Accept: accept };
    if (tokens.token_type === "DPoP") {
      headers.Authorization = `DPoP ${tokens.access_token}`;
      headers.DPoP = await dpopProof(dpopKey, "GET", assetId(url), tokens.access_token);
    } else {
      headers.Authorization = `License ${tokens.access_token}`;
    }
    const res = await fetchPublisher(assetId(url), { headers });
    const challenges = parseChallenges(res.headers.get("www-authenticate"));
    const body = res.headers.get("content-type")?.includes("json") ? await json(res) : await res.text();
    return { status: res.status, ok: res.ok, body, challenges, remaining: res.headers.get("entitlement-remaining") };
  }

  // Spec §12.2 (RFC 7009): revoking the refresh token ends the whole authorization.
  async function revoke(authServer, { clientId, token }) {
    const res = await fetch(authServer.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: clientId }),
    });
    return res.status;
  }

  return { discover, register, authorizationUrl, exchangeCode, refresh, fetchAsset, revoke };
}
