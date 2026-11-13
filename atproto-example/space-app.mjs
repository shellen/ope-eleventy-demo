// ABOUTME: A multi-user atproto app that syncs a managed space once and checks each of its users
// ABOUTME: with OPE before showing them the space's posts. No dependencies: fetch and WebCrypto.

// Under the atproto spaces proposal (0016), a space credential admits an *application*
// to sync a space. It "does not tell it which of its users should see that space". An
// app serving many people may sync with any one user's session, and must decide for
// itself who sees what. For a paid space, that decision is an entitlement check, and OPE
// already has one: a License Token for the space's Asset, held for each user.
//
// So this app does two separate things:
//
//   sync(session)   Ask the space host for a credential, acting for one user (whose
//                   subscription, via the License Server as managing app, admits the app),
//                   then read every writer's posts in the space. Done once for everyone.
//
//   view(user)      Show a user the posts only while the app holds a current License
//                   Token for *that* user, covering the space's Asset. Each user connects
//                   their own subscription (connect), and the app re-checks it by
//                   refreshing the token (spec §12.1) at least every `recheckSeconds`.
//                   A refused refresh (the subscription ended) locks that user's view.
//
// The token is never inspected (spec §9.5): the app reads only the token response's
// `resource` and `expires_in`, and whether the License Server will refresh it.

import { createClient, generateDpopKey, pkce, metadataUrl, b64url } from "../ope-reader/ope-client.js";

// ── atproto: reading a space (proposal 0016) ────────────────────────

// A P-256 key as a did:key (multicodec p256-pub 0x1200, compressed point, base58btc).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}
async function generateCredentialKey() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)); // 0x04 || x || y
  const compressed = new Uint8Array(33);
  compressed[0] = raw[64] & 1 ? 0x03 : 0x02;
  compressed.set(raw.slice(1, 33), 1);
  return { privateKey, did: `did:key:z${base58(new Uint8Array([0x80, 0x24, ...compressed]))}` };
}

// RFC 9421 signature over the credential and its audience, as the proposal specifies:
// components ("authorization" "atproto-space-audience"), tag "atproto-space-credential",
// ecdsa-p256-sha256 with a 64-byte r || s value (which is what WebCrypto produces).
async function spaceCredentialHeaders(key, credential, audience) {
  const authorization = `Atproto-Space-Credential ${credential}`;
  const params = `("authorization" "atproto-space-audience");tag="atproto-space-credential"`;
  const base = `"authorization": ${authorization}\n"atproto-space-audience": ${audience}\n"@signature-params": ${params}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(base)));
  const padded = b64url(sig).replace(/-/g, "+").replace(/_/g, "/");
  return {
    authorization,
    "atproto-space-audience": audience,
    "signature-input": `sig=${params}`,
    signature: `sig=:${padded + "=".repeat((4 - (padded.length % 4)) % 4)}:`,
  };
}

async function xrpc(base, method, { params, body, headers = {} } = {}) {
  const url = new URL(`${base.replace(/\/$/, "")}/xrpc/${method}`);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${method}: ${data.error || res.status}${data.message ? `: ${data.message}` : ""}`);
    err.status = res.status;
    err.xrpc = data.error;
    throw err;
  }
  return data;
}

// ── The app ─────────────────────────────────────────────────────────

// options:
//   space        the space's at:// reference
//   spaceHost    the space host's URL (the authority's PDS)
//   asset        the OPE Asset the space stands for (a scope, like https://blog.example/posts/)
//   collection   the record type to read (posts)
//   clientName, redirectUri   how the app registers with the License Server
//   authorize(url, user)      sends `user` through the License Server's authorization
//                             page and returns the redirect's query ({ code } or { error })
//   recheckSeconds            how stale a user's check may get (default 300)
export function createSpaceApp(options) {
  const { space, spaceHost, asset, collection, clientName = "OPE space app", redirectUri, authorize } = options;
  const recheckSeconds = options.recheckSeconds ?? 300;
  const ope = createClient();
  const users = new Map(); // app user → { tokens, dpopKey, checkedAt } or { locked }
  let authServer = null, clientId = null;
  let posts = [];
  let syncedAt = null;

  // The License Server for the space's Asset, from the Asset's own metadata (RFC 9728).
  async function licenseServer() {
    if (authServer) return authServer;
    const doc = await (await fetch(metadataUrl(asset))).json();
    if (doc.resource !== asset || !doc.ope) throw new Error("no OPE metadata for the space's Asset");
    const issuer = doc.authorization_servers[0];
    const meta = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
    if (meta.issuer !== issuer) throw new Error("License Server metadata issuer mismatch");
    authServer = meta;
    ({ client_id: clientId } = await ope.register(meta, { clientName, redirectUri }));
    return authServer;
  }

  // Sync the space for everyone, acting for one user: a delegation token from that user's
  // own PDS, exchanged at the space host for a credential bound to a fresh key.
  async function sync(session) {
    const { token: delegationToken } = await xrpc(session.pds, "com.atproto.space.getDelegationToken", {
      params: { space }, headers: { authorization: `Bearer ${session.accessJwt}` },
    });
    const key = await generateCredentialKey();
    const { credential } = await xrpc(spaceHost, "com.atproto.space.authorizeSpaceSync", {
      body: { space, credentialKey: key.did, delegationToken },
    });
    const authority = /^at:\/\/([^/]+)\//.exec(space)[1];
    // The writer set: every repo that holds data in the space, asked of the space host
    // (so the signature is addressed to the authority). Removed writers are skipped.
    const { repos: entries = [] } = await xrpc(spaceHost, "com.atproto.space.listWriters", {
      params: { space }, headers: await spaceCredentialHeaders(key, credential, authority),
    });
    const repos = entries.filter((e) => !String(e.$type || "").endsWith("#repoRemoved")).map((e) => e.repo);
    const next = [];
    for (const repo of repos) {
      // Each repo is read from its own host with a signature addressed to its owner.
      // (In this demo every account is on the space host.)
      const { records = [] } = await xrpc(spaceHost, "com.atproto.space.listRecords", {
        params: { space, repo, collection }, headers: await spaceCredentialHeaders(key, credential, repo),
      });
      next.push(...records.map((r) => ({ repo, rkey: r.rkey, ...r.value })));
    }
    posts = next;
    syncedAt = new Date().toISOString();
    return { posts: posts.length, repos: repos.length };
  }

  // A user connects their own OPE subscription: Authorization Code + PKCE + DPoP for the
  // space's Asset, at the License Server the Asset's metadata names (spec §8).
  async function connect(user) {
    const as = await licenseServer();
    const { verifier, challenge } = await pkce();
    const state = crypto.randomUUID();
    const url = ope.authorizationUrl(as, { clientId, redirectUri, resource: asset, codeChallenge: challenge, state });
    const back = await authorize(url, user);
    if (back.error || back.state !== state || back.iss !== as.issuer) {
      const reason = back.error || "the authorization response didn't match";
      users.set(user, { locked: reason });
      return { connected: false, reason };
    }
    const dpopKey = await generateDpopKey();
    const tokens = await ope.exchangeCode(as, { clientId, code: back.code, redirectUri, codeVerifier: verifier, resource: asset }, dpopKey);
    if (!covers(tokens.resource)) {
      users.set(user, { locked: "the token doesn't cover the space's Asset" });
      return { connected: false, reason: "the token doesn't cover the space's Asset" };
    }
    users.set(user, { tokens, dpopKey, checkedAt: Date.now() });
    return { connected: true };
  }

  const covers = (resource) => resource === asset || (resource?.endsWith("/") && asset.startsWith(resource));

  // Is this user entitled right now? Refresh the token when the last check is older than
  // recheckSeconds or the token has expired; the License Server refuses once the
  // subscription has ended (it revokes the grant), and the user's view locks.
  async function check(user) {
    const entry = users.get(user);
    if (!entry) return { ok: false, reason: "not connected" };
    if (entry.locked) return { ok: false, reason: entry.locked };
    const ageSeconds = (Date.now() - entry.checkedAt) / 1000;
    if (ageSeconds >= recheckSeconds || ageSeconds >= (entry.tokens.expires_in ?? 0)) {
      try {
        const tokens = await ope.refresh(await licenseServer(), { clientId, refreshToken: entry.tokens.refresh_token }, entry.dpopKey);
        if (!covers(tokens.resource ?? entry.tokens.resource)) throw new Error("the token no longer covers the space's Asset");
        Object.assign(entry, { tokens: { ...tokens, resource: tokens.resource ?? entry.tokens.resource }, checkedAt: Date.now() });
      } catch (e) {
        users.set(user, { locked: e.oauth?.error || e.message });
        return { ok: false, reason: e.oauth?.error || e.message };
      }
    }
    return { ok: true };
  }

  // What this user sees: the space's posts, or a locked view saying why.
  async function view(user) {
    const verdict = await check(user);
    return verdict.ok ? { locked: false, posts, syncedAt } : { locked: true, reason: verdict.reason, count: posts.length };
  }

  // Forget a user's connection (and end it at the License Server, spec §12.2).
  async function disconnect(user) {
    const entry = users.get(user);
    users.delete(user);
    if (entry?.tokens?.refresh_token) await ope.revoke(await licenseServer(), { clientId, token: entry.tokens.refresh_token });
  }

  return { sync, connect, view, disconnect, get posts() { return posts; } };
}
