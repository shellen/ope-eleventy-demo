// ─────────────────────────────────────────────────────────────
// OPE License Server: readable reference implementation (spec v0.2)
//
// An OAuth 2.0 authorization server that issues OPE License Tokens.
// Written to be read top to bottom next to the spec; each section
// names the spec section it implements. Not hardened for production:
// everything lives in memory and restarts wipe it.
//
//   Discovery        GET  /.well-known/oauth-authorization-server  (§7.2)
//   Keys             GET  /jwks.json                                (§9.3)
//   Registration     POST /register                                 (§8.2, RFC 7591)
//   Authorization    GET  /authorize, POST /login, POST /consent    (§8.1, §8.4)
//   Tokens           POST /token                                    (§8.5, §9, §12.1)
//   Revocation       POST /revoke                                   (§12.2, RFC 7009)
//   Introspection    POST /introspect                               (§12.4, RFC 7662)
//   Account          GET  /account                                  (cancel, disconnect apps)
//
// Environment:
//   PORT                     default 4000
//   OPE_ISSUER               default http://localhost:PORT
//   OPE_PROTECTED_RESOURCES  scopes this server issues for (comma-separated),
//                            default http://localhost:8080/posts/
//   OPE_RS_CLIENT_ID / OPE_RS_CLIENT_SECRET / OPE_RS_PUBLISHER
//                            a Resource Server's introspection credential and the
//                            Publisher it serves (spec §13.4, issued out of band)
//
// Spec: https://feedspec.org/ope/spec/0.2/
// ─────────────────────────────────────────────────────────────

import express from "express";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  SignJWT,
  jwtVerify,
  generateKeyPair,
  exportJWK,
  importJWK,
  decodeProtectedHeader,
  calculateJwkThumbprint,
} from "jose";

const PORT = Number(process.env.PORT || 4000);
const ISSUER = (process.env.OPE_ISSUER || `http://localhost:${PORT}`).replace(/\/$/, "");
const PROTECTED_RESOURCES = (process.env.OPE_PROTECTED_RESOURCES || "http://localhost:8080/posts/")
  .split(",").map((s) => s.trim()).filter(Boolean);
const TOKEN_LIFETIME = 3600; // seconds; spec §9.4 caps group tokens at 3600 and suggests 3600 for all
const CODE_LIFETIME = 60;
const METADATA_MAX_AGE = 24 * 3600 * 1000; // spec §7.3, §13.2

// Introspection credentials for Resource Servers, each tied to the Publishers it
// serves, so one publisher can never introspect another's tokens (spec §13.4).
const RS_CREDENTIALS = new Map();
if (process.env.OPE_RS_CLIENT_SECRET) {
  RS_CREDENTIALS.set(process.env.OPE_RS_CLIENT_ID || "ope-demo-blog", {
    secret: process.env.OPE_RS_CLIENT_SECRET,
    publishers: [process.env.OPE_RS_PUBLISHER || "http://localhost:8080/"],
  });
}

// ── Signing key (spec §9.3: asymmetric, ES256) ──────────────────────
// A fresh key each start. Resource Servers refetch /jwks.json on an unknown kid.

const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const KID = "ls-" + randomBytes(4).toString("hex");
const PUBLIC_JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" };

// Pairwise subject identifiers (spec §8.3, §15): opaque, stable per person and
// Publisher, the same across apps, and never the person's name.
const SUBJECT_SECRET = process.env.OPE_SUBJECT_SECRET || randomBytes(32).toString("hex");
function pairwiseSub(account, publisher) {
  return "s_" + createHmac("sha256", SUBJECT_SECRET).update(`${account}\n${publisher}`).digest("base64url").slice(0, 22);
}

// ── In-memory state ─────────────────────────────────────────────────

const clients = new Map(); //       client_id → registration
const sessions = new Map(); //      session id → account name
const transactions = new Map(); //  txn id → pending authorization request
const codes = new Map(); //         authorization code → { ..., used }
const entitlements = new Map(); //  account → [Entitlement record] (spec §17.1)
const grants = new Map(); //        grant id → one app's authorization for one account
const refreshTokens = new Map(); // refresh token → { grantId, current }
const accessTokens = new Map(); //  jti → { grantId, publisher, revokedReason }
const issuanceLog = []; //          spec §17.4
const metadataCache = new Map(); // URL → { doc, fetchedAt }
const termsCache = new Map(); //    URL → { sha256, fetchedAt }

// ── Helpers ─────────────────────────────────────────────────────────

const now = () => Math.floor(Date.now() / 1000);
const token = (prefix) => prefix + randomBytes(24).toString("base64url");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// RFC 9728 §3.1: the well-known segment goes between the host and the path.
function metadataUrl(identifier) {
  const u = new URL(identifier);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`;
}

// The longest protected_resources entry that covers an Asset (spec §5.5, §13.1).
function coveringScope(resource) {
  return PROTECTED_RESOURCES
    .filter((s) => (s.endsWith("/") ? resource.startsWith(s) : resource === s))
    .sort((a, b) => b.length - a.length)[0];
}

function covers(ent, asset) {
  return ent.coverage === "item" ? ent.resource === asset : asset.startsWith(ent.resource);
}

function oauthError(res, status, error, description) {
  return res.status(status).set("Cache-Control", "no-store").json({ error, error_description: description });
}

function readCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
const sessionAccount = (req) => sessions.get(readCookie(req, "ope_ls_session"));

// ISO 8601 durations in Offers (spec §6.2): enough of the grammar for P#D, P#M, P#Y, PT#H.
function durationSeconds(iso) {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?)?$/.exec(iso || "");
  if (!m) return null;
  const [, y, mo, d, h] = m.map((v) => Number(v || 0));
  return ((y * 365 + mo * 30 + d) * 24 + h) * 3600;
}

// ── Metadata and Terms ingestion (spec §13.2) ───────────────────────
// Fetched from the Publisher's own URLs, cached for at most 24 hours.

async function fetchJsonCached(url) {
  const hit = metadataCache.get(url);
  if (hit && Date.now() - hit.fetchedAt < METADATA_MAX_AGE) return hit.doc;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) return null;
  // Parse as JSON whatever the Content-Type (spec §7.1).
  const doc = JSON.parse(await res.text());
  metadataCache.set(url, { doc, fetchedAt: Date.now() });
  return doc;
}

// Find the metadata that governs an Asset: its own document if it has one,
// otherwise its scope's (spec §5.6, §13.2). Both sides of the trust relationship
// must agree: the Asset is in our protected_resources, and its metadata lists us.
async function resolveAsset(resource) {
  const scope = coveringScope(resource);
  if (!scope) return { error: "invalid_target", description: "this License Server does not issue for that resource" };

  let doc = null;
  try {
    const own = await fetchJsonCached(metadataUrl(resource));
    if (own && own.resource === resource) doc = own;
    if (!doc) {
      const scoped = await fetchJsonCached(metadataUrl(scope));
      if (scoped && scoped.resource === scope) doc = scoped;
    }
  } catch {
    return { error: "temporarily_unavailable", description: "could not fetch the Publisher's metadata" };
  }
  if (!doc || !doc.ope) return { error: "invalid_target", description: "no OPE metadata for that resource" };
  if (!(doc.authorization_servers || []).includes(ISSUER)) {
    return { error: "invalid_target", description: "the Publisher's metadata does not list this License Server" };
  }
  return { doc, scope, publisher: doc.ope.publisher, offers: doc.ope.offers || [] };
}

// Terms digest: an unauthenticated GET, no cookies, content coding removed (spec §6.1).
async function termsReference(terms) {
  const hit = termsCache.get(terms.url);
  if (hit && Date.now() - hit.fetchedAt < METADATA_MAX_AGE) return { ...terms, sha256: hit.sha256 };
  const res = await fetch(terms.url, terms.type ? { headers: { Accept: terms.type } } : {});
  const body = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(body).digest("base64url");
  termsCache.set(terms.url, { sha256, fetchedAt: Date.now() });
  return { ...terms, sha256 };
}

// ── Entitlement records (spec §17) ──────────────────────────────────

function activeEntitlementFor(account, resource, publisher) {
  return (entitlements.get(account) || [])
    .filter((e) => e.state === "active" && e.publisher === publisher && covers(e, resource))
    // Prefer the widest coverage, so a subscriber gets a token for the whole scope.
    // (Every Entitlement here is a direct purchase; spec §13.7 orders group ones after.)
    .sort((a, b) => (a.coverage === "collection" ? -1 : 1) - (b.coverage === "collection" ? -1 : 1))[0];
}

// The demo's stand-in for checkout: choosing an Offer creates the Entitlement.
function grantOffer(account, offer, resolved, resource) {
  const isSubscription = offer.payment.type === "subscription";
  const record = {
    id: "ent_" + randomBytes(6).toString("hex"),
    resource: isSubscription ? resolved.scope : resource,
    coverage: isSubscription ? "collection" : "item",
    publisher: resolved.publisher,
    type: "access",
    duration: isSubscription ? "recurring" : offer.payment.type === "rental" ? "rental" : "perpetual",
    source: "direct",
    offer: offer.id,
    offerName: offer.name,
    terms: offer.terms,
    state: "active",
    changed: new Date().toISOString(),
    cause: `demo checkout: ${offer.id}`,
  };
  if (record.duration === "rental") record.rental_expires_at = now() + (durationSeconds(offer.payment.period) || 72 * 3600);
  entitlements.set(account, [...(entitlements.get(account) || []), record]);
  return record;
}

// A transition out of active revokes outstanding tokens (spec §17.2).
function endEntitlement(account, id) {
  const ent = (entitlements.get(account) || []).find((e) => e.id === id);
  if (!ent || ent.state !== "active") return;
  ent.state = "ended";
  ent.changed = new Date().toISOString();
  for (const grant of grants.values()) {
    if (grant.account === account && grant.entitlementId === id) revokeGrant(grant.id, "entitlement_ended");
  }
}

// ── Tokens (spec §9) ────────────────────────────────────────────────

async function issueTokens(grant, ent, resolved) {
  const offer = resolved.offers.find((o) => o.id === ent.offer) || resolved.offers[0];
  const iat = now();
  let exp = iat + TOKEN_LIFETIME;
  if (ent.duration === "rental") exp = Math.min(exp, ent.rental_expires_at); // spec §10.2
  const jti = "lt_" + randomBytes(8).toString("hex");

  const entitlement = {
    type: ent.type,
    coverage: ent.coverage,
    duration: ent.duration,
    source: ent.source,
    ...(ent.rental_expires_at ? { rental_expires_at: ent.rental_expires_at } : {}),
    ...(ent.offer ? { offer: ent.offer } : {}),
  };
  const aud = [new URL(ent.resource).origin, ...((resolved.doc.ope.audience) || [])];
  const claims = {
    sub: pairwiseSub(grant.account, resolved.publisher),
    client_id: grant.clientId,
    aud,
    resource: ent.resource,
    publisher: resolved.publisher,
    terms: await termsReference(offer.terms || { url: resolved.doc.resource_tos_uri }),
    entitlement,
    ...(grant.jkt ? { cnf: { jkt: grant.jkt } } : {}),
  };
  const accessToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", typ: "license+jwt", kid: KID })
    .setIssuer(ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(privateKey);

  accessTokens.set(jti, { grantId: grant.id, publisher: resolved.publisher, exp, revokedReason: null });

  // Rotate the refresh token: the old one stays on record as spent, so its reuse
  // is detected as theft (spec §12.1).
  for (const info of refreshTokens.values()) if (info.grantId === grant.id) info.current = false;
  const refreshToken = token("rt_");
  refreshTokens.set(refreshToken, { grantId: grant.id, current: true });

  issuanceLog.push({ jti, sub: claims.sub, client_id: grant.clientId, resource: ent.resource, iat, exp, terms_sha256: claims.terms.sha256, state: ent.state });

  return {
    access_token: accessToken,
    token_type: grant.jkt ? "DPoP" : "License",
    expires_in: exp - iat,
    refresh_token: refreshToken,
    resource: ent.resource, // spec §8.5: which Assets this token covers
    entitlement,
  };
}

function revokeGrant(grantId, reason) {
  const grant = grants.get(grantId);
  if (!grant || grant.revokedReason) return;
  grant.revokedReason = reason;
  for (const info of accessTokens.values()) if (info.grantId === grantId && !info.revokedReason) info.revokedReason = reason;
  for (const info of refreshTokens.values()) if (info.grantId === grantId) info.current = false;
}

// DPoP proof at the token endpoint (RFC 9449 §4.3): returns the key's thumbprint.
const seenProofs = new Map();
async function verifyDpopProof(proof, htm, htu) {
  const header = decodeProtectedHeader(proof);
  if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || !header.jwk || header.jwk.d) {
    throw new Error("malformed DPoP proof");
  }
  const { payload } = await jwtVerify(proof, await importJWK(header.jwk, "ES256"), {
    typ: "dpop+jwt", algorithms: ["ES256"], maxTokenAge: "120s", clockTolerance: 30,
  });
  if (payload.htm !== htm || payload.htu !== htu) throw new Error("DPoP proof is for another request");
  const t = Date.now();
  for (const [jti, expiry] of seenProofs) if (expiry < t) seenProofs.delete(jti);
  if (!payload.jti || seenProofs.has(payload.jti)) throw new Error("DPoP proof replayed");
  seenProofs.set(payload.jti, t + 240 * 1000);
  return calculateJwkThumbprint(header.jwk, "sha256");
}

// ── Pages ───────────────────────────────────────────────────────────

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}: OPE Demo License Server</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #18181b; }
  h1 { font-size: 1.4rem; } .muted { color: #52525b; font-size: 0.9rem; }
  .card { border: 1px solid #e4e4e7; border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; }
  .warn { background: #fffbeb; border-color: #fcd34d; }
  button { font: inherit; padding: 0.5rem 1rem; border-radius: 8px; border: 1px solid #a1a1aa; background: #fff; cursor: pointer; margin: 0.25rem 0.25rem 0 0; }
  button.primary { background: #10b981; border-color: #10b981; color: #18181b; font-weight: 600; }
  input { font: inherit; padding: 0.45rem; border: 1px solid #a1a1aa; border-radius: 6px; }
  a { color: #047857; }
</style></head><body>
<p class="muted">OPE Demo License Server · <a href="/account">Your account</a></p>
${body}</body></html>`;
}

function loginPage(txn, message) {
  return page("Sign in", `<h1>Sign in</h1>
${message ? `<p class="muted">${esc(message)}</p>` : ""}
<p class="muted">This is a demo: any name works, and there is no password. Your name is never shared with publishers or apps; they see an opaque identifier instead.</p>
<form method="post" action="/login">
  <input type="hidden" name="txn" value="${esc(txn || "")}">
  <label>Name <input name="account" required autofocus></label>
  <button class="primary" type="submit">Sign in</button>
</form>`);
}

// Consent (spec §8.4): the app's name and that it is unreviewed, what is being
// authorized by Offer name, a link to the Terms, the lifetime, and how to revoke.
function consentPage(t, account) {
  const client = clients.get(t.clientId);
  const ent = activeEntitlementFor(account, t.resource, t.resolved.publisher);
  const terms = (t.resolved.offers[0] && t.resolved.offers[0].terms) || { url: t.resolved.doc.resource_tos_uri };
  const holding = ent
    ? `<div class="card"><strong>You have:</strong> ${esc(ent.offerName || ent.offer)}</div>
       <button class="primary" name="action" value="approve">Allow</button>`
    : `<div class="card"><strong>You don't have access to this yet.</strong> Choose an offer (demo checkout, no payment):
       <div>${t.resolved.offers.map((o) => `<button class="primary" name="action" value="offer:${esc(o.id)}">${esc(o.name)}${o.payment.amount ? ` ($${esc(o.payment.amount)})` : ""}</button>`).join("")}</div></div>`;
  return page("Allow access", `<h1>${esc(client.client_name || t.clientId)} wants to use your access</h1>
<div class="card warn"><strong>Unreviewed app.</strong> ${esc(client.client_name || "This app")} registered itself with this License Server and hasn't been reviewed.</div>
<p>Publisher: <strong>${esc(t.resolved.doc.resource_name || t.resolved.publisher)}</strong><br>
<span class="muted">${esc(t.resource)}</span></p>
<p class="muted">Signed in as ${esc(account)}. Each token lasts 1 hour and refreshes while your access is active.
See the publisher's <a href="${esc(terms.url)}" target="_blank" rel="noopener">terms</a>.
You can disconnect this app any time from <a href="/account">your account</a>.</p>
<form method="post" action="/consent">
  <input type="hidden" name="txn" value="${esc(t.id)}">
  ${holding}
  <button name="action" value="deny">Deny</button>
</form>`);
}

// ── App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// CORS: public endpoints are callable from any origin, without credentials
// (Web profile). Apps may be native, extensions, or pages on any origin.
const PUBLIC_PATHS = ["/.well-known/oauth-authorization-server", "/jwks.json", "/register", "/token", "/revoke"];
app.use((req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path)) {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, DPoP, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Expose-Headers": "DPoP-Nonce",
    });
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

// ── Discovery (spec §7.2, RFC 8414) ──
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.set("Cache-Control", "public, max-age=3600").json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    revocation_endpoint: `${ISSUER}/revoke`,
    introspection_endpoint: `${ISSUER}/introspect`,
    jwks_uri: `${ISSUER}/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    dpop_signing_alg_values_supported: ["ES256"],
    authorization_response_iss_parameter_supported: true,
    protected_resources: PROTECTED_RESOURCES,
    ope: {
      version: "0.2",
      entitlement_types_supported: ["access"],
      max_token_lifetime: TOKEN_LIFETIME,
      profiles: ["feeds", "web"],
    },
  });
});

app.get("/jwks.json", (_req, res) => res.set("Cache-Control", "public, max-age=300").json({ keys: [PUBLIC_JWK] }));

// ── Dynamic Client Registration (RFC 7591; spec §8.2) ──
// Public clients only: no client_secret is ever issued. Redirect URIs must be
// loopback (native apps, RFC 8252), https, or a private-use scheme.
app.post("/register", (req, res) => {
  const { client_name, redirect_uris, client_uri } = req.body || {};
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris is required");
  }
  for (const uri of redirect_uris) {
    let u;
    try { u = new URL(uri); } catch { return oauthError(res, 400, "invalid_redirect_uri", `not a URL: ${uri}`); }
    const loopback = u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.hash || !(loopback || u.protocol === "https:" || /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(u.protocol))) {
      return oauthError(res, 400, "invalid_redirect_uri", `redirect URI not allowed: ${uri}`);
    }
  }
  const client_id = "app_" + randomBytes(8).toString("hex");
  const registration = {
    client_id,
    client_name: String(client_name || "Unnamed app").slice(0, 80),
    ...(client_uri ? { client_uri } : {}),
    redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_id_issued_at: now(),
  };
  clients.set(client_id, registration);
  console.log(`  [license] Registered app ${client_id} (${registration.client_name})`);
  res.status(201).json(registration);
});

// ── Authorization (spec §8.1): Authorization Code + PKCE, exactly one resource ──
app.get("/authorize", async (req, res) => {
  const q = req.query;
  const client = clients.get(q.client_id);
  // Until the client and redirect URI check out, errors are shown here, never redirected.
  if (!client) return res.status(400).send(page("Error", "<h1>Unknown app</h1>"));
  if (!client.redirect_uris.includes(q.redirect_uri)) {
    return res.status(400).send(page("Error", "<h1>Redirect URI doesn't match the app's registration</h1>"));
  }
  const back = (error, description) => {
    const u = new URL(q.redirect_uri);
    u.searchParams.set("error", error);
    if (description) u.searchParams.set("error_description", description);
    if (q.state) u.searchParams.set("state", q.state);
    u.searchParams.set("iss", ISSUER);
    return res.redirect(303, u.href);
  };
  if (q.response_type !== "code") return back("unsupported_response_type");
  if (!q.code_challenge || q.code_challenge_method !== "S256") return back("invalid_request", "PKCE with S256 is required");
  if (typeof q.resource !== "string") return back("invalid_target", "exactly one resource is required"); // spec §8.1

  const resolved = await resolveAsset(q.resource);
  if (resolved.error) return back(resolved.error, resolved.description);
  const policy = resolved.doc.ope.client_policy;
  if (policy && !(policy.allow || []).some((e) => e.domain === "*")) {
    return back("access_denied", "this Publisher only allows reviewed apps"); // no app here is reviewed
  }

  const id = token("txn_");
  transactions.set(id, {
    id,
    clientId: q.client_id,
    redirectUri: q.redirect_uri,
    state: q.state,
    codeChallenge: q.code_challenge,
    resource: q.resource,
    resolved,
    expires: Date.now() + 10 * 60 * 1000,
  });
  const account = sessionAccount(req);
  res.send(account ? consentPage(transactions.get(id), account) : loginPage(id));
});

app.post("/login", (req, res) => {
  const account = String(req.body.account || "").trim().slice(0, 60);
  if (!account) return res.status(400).send(loginPage(req.body.txn, "Enter a name."));
  const sid = token("sid_");
  sessions.set(sid, account);
  res.set("Set-Cookie", `ope_ls_session=${sid}; HttpOnly; SameSite=Lax; Path=/`);
  const t = transactions.get(req.body.txn);
  if (t) return res.send(consentPage(t, account));
  res.redirect(303, "/account");
});

app.post("/consent", (req, res) => {
  const t = transactions.get(req.body.txn);
  const account = sessionAccount(req);
  if (!t || t.expires < Date.now()) return res.status(400).send(page("Error", "<h1>This request expired. Start again from the app.</h1>"));
  if (!account) return res.send(loginPage(t.id));
  transactions.delete(t.id);

  const back = (params) => {
    const u = new URL(t.redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (t.state) u.searchParams.set("state", t.state);
    u.searchParams.set("iss", ISSUER); // RFC 9207
    return res.redirect(303, u.href);
  };

  const action = String(req.body.action || "");
  if (action === "deny") return back({ error: "access_denied" });
  if (action.startsWith("offer:")) {
    const offer = t.resolved.offers.find((o) => o.id === action.slice(6));
    if (!offer) return back({ error: "invalid_request", error_description: "unknown offer" });
    grantOffer(account, offer, t.resolved, t.resource);
    console.log(`  [license] Demo checkout: ${account} took ${offer.id}`);
  }
  if (!activeEntitlementFor(account, t.resource, t.resolved.publisher)) {
    return back({ error: "no_entitlement", error_description: "you hold no Entitlement for this resource" });
  }

  const code = token("code_");
  codes.set(code, {
    clientId: t.clientId,
    redirectUri: t.redirectUri,
    codeChallenge: t.codeChallenge,
    resource: t.resource,
    account,
    expires: now() + CODE_LIFETIME,
    used: false,
  });
  back({ code });
});

// ── Token endpoint (spec §8.5, §12.1) ──
app.post("/token", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const b = req.body;
  const client = clients.get(b.client_id);
  if (!client) return oauthError(res, 401, "invalid_client", "unknown client_id");

  // A DPoP proof binds the tokens to the app's key (RFC 9449).
  let jkt = null;
  if (req.headers.dpop) {
    try {
      jkt = await verifyDpopProof(req.headers.dpop, "POST", `${ISSUER}/token`);
    } catch (e) {
      return oauthError(res, 400, "invalid_dpop_proof", e.message);
    }
  }

  if (b.grant_type === "authorization_code") {
    const c = codes.get(b.code);
    if (!c || c.used || c.expires < now() || c.clientId !== b.client_id || c.redirectUri !== b.redirect_uri) {
      return oauthError(res, 400, "invalid_grant", "invalid or expired code");
    }
    c.used = true;
    const challenge = createHash("sha256").update(String(b.code_verifier || "")).digest("base64url");
    if (challenge.length !== c.codeChallenge.length || !timingSafeEqual(Buffer.from(challenge), Buffer.from(c.codeChallenge))) {
      return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
    }
    if (b.resource && b.resource !== c.resource) return oauthError(res, 400, "invalid_target", "resource differs from the authorization request");

    const resolved = await resolveAsset(c.resource);
    if (resolved.error) return oauthError(res, 400, resolved.error, resolved.description);
    const ent = activeEntitlementFor(c.account, c.resource, resolved.publisher);
    if (!ent) return oauthError(res, 400, "no_entitlement", "you hold no Entitlement for this resource");

    const grant = { id: token("grant_"), clientId: b.client_id, account: c.account, resource: c.resource, entitlementId: ent.id, jkt, revokedReason: null };
    grants.set(grant.id, grant);
    console.log(`  [license] Token for ${client.client_name}: ${ent.coverage} ${ent.resource}${jkt ? " (DPoP-bound)" : " (unbound)"}`);
    return res.json(await issueTokens(grant, ent, resolved));
  }

  if (b.grant_type === "refresh_token") {
    const info = refreshTokens.get(b.refresh_token);
    if (!info) return oauthError(res, 400, "invalid_grant", "unknown refresh token");
    const grant = grants.get(info.grantId);
    if (!grant || grant.clientId !== b.client_id) return oauthError(res, 400, "invalid_grant", "refresh token belongs to another app");
    if (!info.current) {
      // A spent refresh token came back: someone copied it. End the whole grant (spec §12.1).
      revokeGrant(grant.id, "operator");
      console.log(`  [license] Refresh token reuse detected for ${client.client_name}; grant revoked`);
      return oauthError(res, 400, "invalid_grant", "refresh token reused; this authorization has been revoked");
    }
    if (grant.revokedReason) return oauthError(res, 400, "invalid_grant", `authorization revoked: ${grant.revokedReason}`);
    if (grant.jkt && grant.jkt !== jkt) return oauthError(res, 400, "invalid_grant", "DPoP proof with the bound key is required");
    if (b.resource && b.resource !== grant.resource) return oauthError(res, 400, "invalid_target", "resource differs from the grant");

    const resolved = await resolveAsset(grant.resource);
    if (resolved.error) return oauthError(res, 400, resolved.error, resolved.description);
    const ent = (entitlements.get(grant.account) || []).find((e) => e.id === grant.entitlementId);
    if (!ent || ent.state !== "active") {
      return oauthError(res, 400, ent && ent.state === "suspended" ? "entitlement_suspended" : "no_entitlement", "the Entitlement is no longer active");
    }
    return res.json(await issueTokens(grant, ent, resolved));
  }

  return oauthError(res, 400, "unsupported_grant_type", "authorization_code or refresh_token");
});

// ── Revocation (spec §12.2, RFC 7009): always 200 ──
app.post("/revoke", async (req, res) => {
  const { token: t, client_id } = req.body;
  const refresh = refreshTokens.get(t);
  if (refresh) {
    const grant = grants.get(refresh.grantId);
    // Revoking a refresh token also revokes the access tokens issued from it.
    if (grant && grant.clientId === client_id) revokeGrant(grant.id, "client_revoked");
    return res.sendStatus(200);
  }
  try {
    const { payload } = await jwtVerify(t, publicKey, { issuer: ISSUER, typ: "license+jwt" });
    const info = accessTokens.get(payload.jti);
    if (info && payload.client_id === client_id && !info.revokedReason) info.revokedReason = "client_revoked";
  } catch { /* unknown or invalid tokens are ignored, per RFC 7009 */ }
  res.sendStatus(200);
});

// ── Introspection (spec §12.4, RFC 7662, with RSL's resource/permitted) ──
app.post("/introspect", async (req, res) => {
  const [id, secret] = Buffer.from((req.headers.authorization || "").replace(/^Basic\s+/i, ""), "base64").toString().split(":");
  const cred = RS_CREDENTIALS.get(id);
  if (!cred || !secret || cred.secret.length !== secret.length || !timingSafeEqual(Buffer.from(cred.secret), Buffer.from(secret))) {
    return oauthError(res, 401, "invalid_client", "introspection requires a Resource Server credential");
  }
  res.set("Cache-Control", "no-store");
  let payload;
  try {
    ({ payload } = await jwtVerify(req.body.token, publicKey, { issuer: ISSUER, typ: "license+jwt" }));
  } catch (e) {
    const expired = e.code === "ERR_JWT_EXPIRED";
    return res.json({ active: false, ...(expired && cred.publishers.includes(e.payload?.publisher) ? { revocation_reason: "expired" } : {}) });
  }
  // A Resource Server only ever learns about its own Publisher's tokens (spec §13.4).
  if (!cred.publishers.includes(payload.publisher)) return res.json({ active: false });

  const info = accessTokens.get(payload.jti);
  const grant = info && grants.get(info.grantId);
  const reason = !info ? "operator" : info.revokedReason || (grant && grant.revokedReason);
  if (reason) return res.json({ active: false, revocation_reason: reason });

  const response = {
    active: true,
    token_type: payload.cnf ? "DPoP" : "License",
    sub: payload.sub,
    client_id: payload.client_id,
    aud: payload.aud,
    resource: payload.resource,
    publisher: payload.publisher,
    terms: payload.terms,
    entitlement: payload.entitlement,
    exp: payload.exp,
    iat: payload.iat,
    ...(payload.cnf ? { cnf: payload.cnf } : {}),
  };
  if (req.body.resource) {
    const e = payload.entitlement;
    const coversIt = e.coverage === "item" ? payload.resource === req.body.resource : req.body.resource.startsWith(payload.resource);
    const notEnded = !(e.duration === "rental" && now() >= e.rental_expires_at);
    response.permitted = coversIt && (e.type === "access" || e.type === "limit") && notEnded;
  }
  res.json(response);
});

// ── Account: subscriptions and connected apps ──
app.get("/account", (req, res) => {
  const account = sessionAccount(req);
  if (!account) return res.send(loginPage(null, "Sign in to see your subscriptions and connected apps."));
  const ents = entitlements.get(account) || [];
  const apps = [...grants.values()].filter((g) => g.account === account && !g.revokedReason);
  res.send(page("Your account", `<h1>${esc(account)}</h1>
<h2>Subscriptions and purchases</h2>
${ents.length ? ents.map((e) => `<div class="card"><strong>${esc(e.offerName || e.offer)}</strong> · ${esc(e.state)}<br>
  <span class="muted">${esc(e.coverage)} ${esc(e.resource)}</span>
  ${e.state === "active" ? `<form method="post" action="/account/cancel"><input type="hidden" name="id" value="${esc(e.id)}"><button>Cancel</button></form>` : ""}</div>`).join("") : `<p class="muted">None yet. Subscribe from any OPE app.</p>`}
<h2>Connected apps</h2>
${apps.length ? apps.map((g) => `<div class="card"><strong>${esc(clients.get(g.clientId)?.client_name || g.clientId)}</strong><br>
  <span class="muted">${esc(g.resource)}${g.jkt ? " · DPoP-bound" : ""}</span>
  <form method="post" action="/account/disconnect"><input type="hidden" name="grant" value="${esc(g.id)}"><button>Disconnect</button></form></div>`).join("") : `<p class="muted">No apps connected.</p>`}
<form method="post" action="/account/logout"><button>Sign out</button></form>`));
});

app.post("/account/cancel", (req, res) => {
  const account = sessionAccount(req);
  if (account) {
    endEntitlement(account, req.body.id);
    console.log(`  [license] ${account} cancelled ${req.body.id}; outstanding tokens revoked`);
  }
  res.redirect(303, "/account");
});

app.post("/account/disconnect", (req, res) => {
  const account = sessionAccount(req);
  const grant = grants.get(req.body.grant);
  if (account && grant && grant.account === account) revokeGrant(grant.id, "client_revoked");
  res.redirect(303, "/account");
});

app.post("/account/logout", (req, res) => {
  sessions.delete(readCookie(req, "ope_ls_session"));
  res.set("Set-Cookie", "ope_ls_session=; Max-Age=0; Path=/").redirect(303, "/account");
});

// ── Start ──
const server = app.listen(PORT, () => {
  console.log(`\n  OPE License Server running on ${ISSUER}`);
  console.log(`  Metadata:   ${ISSUER}/.well-known/oauth-authorization-server`);
  console.log(`  Issues for: ${PROTECTED_RESOURCES.join(", ")}`);
  console.log(`  Introspection credentials: ${RS_CREDENTIALS.size ? [...RS_CREDENTIALS.keys()].join(", ") : "none"}\n`);
});

export { server, app, issuanceLog };
