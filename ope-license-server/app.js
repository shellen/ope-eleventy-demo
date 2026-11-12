// ─────────────────────────────────────────────────────────────
// OPE License Server: readable reference implementation (spec v0.2)
// The app itself. server.js runs it locally; netlify/functions/ls.mjs runs it
// on Netlify with its state in Netlify Blobs.
//
// An OAuth 2.0 authorization server that issues OPE License Tokens.
// Written to be read top to bottom next to the spec; each section
// names the spec section it implements. Not hardened for production:
// locally everything lives in memory, and on Netlify in one Netlify Blobs entry.
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
//   OPE_ISSUER               default: Netlify's URL, else http://localhost:PORT
//   OPE_LS_KEY               private P-256 JWK for signing (scripts/generate-key.mjs);
//                            default: a fresh key each start
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
import { createSpaceManager, CHECK_ACCESS, CHECK_USER_ACCESS } from "./atproto.js";
import { startLink, finishLink, clientFor, clientMetadata } from "./atproto-oauth.js";

const PORT = Number(process.env.PORT || 4000);
// On Netlify, URL is the site's address; OPE_ISSUER overrides it.
const ISSUER = (process.env.OPE_ISSUER || process.env.URL || `http://localhost:${PORT}`).replace(/\/$/, "");
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
    // Default: the origin of the first protected resource, as a Publisher identifier.
    publishers: [process.env.OPE_RS_PUBLISHER || new URL(PROTECTED_RESOURCES[0]).origin + "/"],
  });
}

// The publisher's own site as a confidential client (spec Web profile): it signs
// readers in from its server, keeps the token in its own HttpOnly cookie, and
// authenticates with the same secret it uses for introspection. Registered out of
// band, so it's defined here rather than in the stored client list.
const SITE_CLIENTS = new Map([...RS_CREDENTIALS].map(([id, cred]) => [id, {
  client_id: id,
  client_name: process.env.OPE_SITE_NAME || "The publisher's site",
  redirect_uris: cred.publishers.map((p) => `${p.replace(/\/$/, "")}/_ope/callback`),
  token_endpoint_auth_method: "client_secret_basic",
  confidential: true,
  secret: cred.secret,
}]));
const getClient = (id) => clients.get(id) || SITE_CLIENTS.get(id);

// ── Signing key (spec §9.3: asymmetric, ES256) ──────────────────────
// A fresh key each start. Resource Servers refetch /jwks.json on an unknown kid.

// OPE_LS_KEY holds a private P-256 JWK (scripts/generate-key.mjs makes one). Without
// it, a fresh key each start: fine locally, but a hosted server needs a stable key.
let privateKey, publicKey, KID, PUBLIC_JWK;
async function loadKeys() {
  let jwk;
  if (process.env.OPE_LS_KEY) {
    jwk = JSON.parse(process.env.OPE_LS_KEY);
  } else {
    const pair = await generateKeyPair("ES256", { extractable: true });
    jwk = await exportJWK(pair.privateKey);
  }
  const { kty, crv, x, y } = jwk;
  privateKey = await importJWK(jwk, "ES256");
  publicKey = await importJWK({ kty, crv, x, y }, "ES256");
  KID = "ls-" + (await calculateJwkThumbprint({ kty, crv, x, y })).slice(0, 12);
  PUBLIC_JWK = { kty, crv, x, y, kid: KID, alg: "ES256", use: "sig" };
}
// Loaded on first use: Cloudflare Workers don't allow generating keys or random
// values while a module loads, only inside a request.
let keysReady;
const ensureKeys = () => (keysReady ||= loadKeys());

// Pairwise subject identifiers (spec §8.3, §15): opaque, stable per person and
// Publisher, the same across apps, and never the person's name.
// Stable across restarts when OPE_LS_KEY is set (derived from it), unless set itself.
// Chosen on first use, for the same reason as the keys.
let subjectSecret;
function getSubjectSecret() {
  return (subjectSecret ||= process.env.OPE_SUBJECT_SECRET
    || (process.env.OPE_LS_KEY
      ? createHash("sha256").update("ope-subject\n" + JSON.parse(process.env.OPE_LS_KEY).d).digest("hex")
      : randomBytes(32).toString("hex")));
}
function pairwiseSub(account, publisher) {
  return "s_" + createHmac("sha256", getSubjectSecret()).update(`${account}\n${publisher}`).digest("base64url").slice(0, 22);
}

// ── State ───────────────────────────────────────────────────────────
// In memory. Locally it lives as long as the process; on Netlify the function
// loads it from Netlify Blobs before each request and saves it after
// (exportState / importState at the end of this file).

const clients = new Map(); //       client_id → registration
const sessions = new Map(); //      session id → account name
const transactions = new Map(); //  txn id → pending authorization request
const codes = new Map(); //         authorization code → { ..., used }
const entitlements = new Map(); //  account → [Entitlement record] (spec §17.1)
const grants = new Map(); //        grant id → one app's authorization for one account
const refreshTokens = new Map(); // refresh token → { grantId, current }
const accessTokens = new Map(); //  jti → { grantId, publisher, revokedReason }
const issuanceLog = []; //          spec §17.4
const atprotoLinks = new Map(); //  account → { did, handle } (prototype ATProto profile; see atproto.js)
const atprotoTxns = new Map();  //  state → { account, …sign-in in progress } (atproto-oauth.js)
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
  const client = getClient(t.clientId);
  const ent = activeEntitlementFor(account, t.resource, t.resolved.publisher);
  const terms = (t.resolved.offers[0] && t.resolved.offers[0].terms) || { url: t.resolved.doc.resource_tos_uri };
  const holding = ent
    ? `<div class="card"><strong>You have:</strong> ${esc(ent.offerName || ent.offer)}</div>
       <button class="primary" name="action" value="approve">Allow</button>`
    : `<div class="card"><strong>You don't have access to this yet.</strong> Choose an offer (demo checkout, no payment):
       <div>${t.resolved.offers.map((o) => `<button class="primary" name="action" value="offer:${esc(o.id)}">${esc(o.name)}${o.payment.amount ? ` ($${esc(o.payment.amount)})` : ""}</button>`).join("")}</div></div>`;
  return page("Allow access", `<h1>${esc(client.client_name || t.clientId)} wants to use your access</h1>
${client.confidential
  ? `<div class="card"><strong>This is the publisher's own site.</strong> It keeps your access in a cookie on that site, so you can read there.</div>`
  : `<div class="card warn"><strong>Unreviewed app.</strong> ${esc(client.client_name || "This app")} registered itself with this License Server and hasn't been reviewed.</div>`}
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
app.use(async (_req, _res, next) => { await ensureKeys(); next(); });
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// CORS: public endpoints are callable from any origin, without credentials
// (Web profile). Apps may be native, extensions, or pages on any origin.
const PUBLIC_PATHS = ["/.well-known/oauth-authorization-server", "/jwks.json", "/register", "/token", "/revoke", "/.well-known/did.json"];

// ── ATProto profile prototype (spec Profile E notes; atproto spaces are alpha) ──
// OPE_MANAGED_SPACES: [{ "space": "at://<publisher DID>/space/<type>/<skey>", "resource": "<OPE resource>" }]
// A publisher sets its space's managingApp to this server's did:web#ope_space_manager.
const MANAGED_SPACES = (() => {
  try { return JSON.parse(process.env.OPE_MANAGED_SPACES || "[]"); } catch { return []; }
})();
let keyResolverOverride = null; // tests supply a resolver instead of fetching DID documents
const keyResolverOverrideOr = (did, force) => (keyResolverOverride ? keyResolverOverride(did, force) : null);
const spaceManager = createSpaceManager({
  issuer: ISSUER,
  spaces: MANAGED_SPACES,
  resolveKey: keyResolverOverrideOr,
  entitled: (did, resource) => {
    const account = [...atprotoLinks].find(([, link]) => link.did === did)?.[0];
    return Boolean(account) && (entitlements.get(account) || []).some((e) => e.state === "active" && covers(e, resource));
  },
});
function setAtprotoKeyResolver(fn) { keyResolverOverride = fn; }
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

app.get("/", (_req, res) => res.redirect(303, "/account"));

// This server's atproto identity, so a space can name it as its managing app.
app.get("/.well-known/did.json", (_req, res) => res.json(spaceManager.didDocument()));
app.get(`/xrpc/${CHECK_ACCESS}`, spaceManager.checkAccess);
app.get(`/xrpc/${CHECK_USER_ACCESS}`, spaceManager.checkAccess);

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
  const client = getClient(q.client_id);
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
  if (!account) return res.send(loginPage(id));
  proceed(transactions.get(id), account, res);
});

// After sign-in: the publisher's own site gets a code straight away when the reader
// already has access (it was registered out of band; there's nothing new to consent
// to). Every other app shows the consent screen.
function proceed(t, account, res) {
  if (getClient(t.clientId)?.confidential && activeEntitlementFor(account, t.resource, t.resolved.publisher)) {
    transactions.delete(t.id);
    return res.redirect(303, codeRedirect(t, account));
  }
  res.send(consentPage(t, account));
}

function authorizationRedirect(t, params) {
  const u = new URL(t.redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (t.state) u.searchParams.set("state", t.state);
  u.searchParams.set("iss", ISSUER); // RFC 9207
  return u.href;
}

function codeRedirect(t, account) {
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
  return authorizationRedirect(t, { code });
}

app.post("/login", (req, res) => {
  const account = String(req.body.account || "").trim().slice(0, 60);
  if (!account) return res.status(400).send(loginPage(req.body.txn, "Enter a name."));
  const sid = token("sid_");
  sessions.set(sid, account);
  res.set("Set-Cookie", `ope_ls_session=${sid}; HttpOnly; SameSite=Lax; Path=/`);
  const t = transactions.get(req.body.txn);
  if (t) return proceed(t, account, res);
  res.redirect(303, "/account");
});

app.post("/consent", (req, res) => {
  const t = transactions.get(req.body.txn);
  const account = sessionAccount(req);
  if (!t || t.expires < Date.now()) return res.status(400).send(page("Error", "<h1>This request expired. Start again from the app.</h1>"));
  if (!account) return res.send(loginPage(t.id));
  transactions.delete(t.id);

  const back = (params) => res.redirect(303, authorizationRedirect(t, params));

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

  res.redirect(303, codeRedirect(t, account));
});

// ── Token endpoint (spec §8.5, §12.1) ──
app.post("/token", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const b = req.body;
  // Confidential clients authenticate with HTTP Basic (or client_secret in the body).
  const basic = (req.headers.authorization || "").match(/^Basic\s+(.+)$/i);
  let clientId = b.client_id;
  let secret = b.client_secret;
  if (basic) {
    const [id, pw] = Buffer.from(basic[1], "base64").toString().split(":");
    clientId = decodeURIComponent(id || "");
    secret = decodeURIComponent(pw || "");
  }
  const client = getClient(clientId);
  if (!client) return oauthError(res, 401, "invalid_client", "unknown client_id");
  if (client.confidential) {
    const ok = typeof secret === "string" && secret.length === client.secret.length
      && timingSafeEqual(Buffer.from(secret), Buffer.from(client.secret));
    if (!ok) return oauthError(res, 401, "invalid_client", "client authentication failed");
  }
  b.client_id = clientId;

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
${apps.length ? apps.map((g) => `<div class="card"><strong>${esc(getClient(g.clientId)?.client_name || g.clientId)}</strong><br>
  <span class="muted">${esc(g.resource)}${g.jkt ? " · DPoP-bound" : ""}</span>
  <form method="post" action="/account/disconnect"><input type="hidden" name="grant" value="${esc(g.id)}"><button>Disconnect</button></form></div>`).join("") : `<p class="muted">No apps connected.</p>`}
<h2>AT Protocol <span class="muted" style="font-size:0.8rem;font-weight:normal">prototype</span></h2>
${atprotoLinks.get(account)
  ? `<div class="card"><strong>@${esc(atprotoLinks.get(account).handle)}</strong><br><span class="muted">${esc(atprotoLinks.get(account).did)} · signed in to link</span>
     <p class="muted">Publishers whose atproto space is managed by this License Server let this account read it while your subscription is active.</p>
     <form method="post" action="/account/atproto/unlink"><button>Unlink</button></form></div>`
  : `${req.query.atproto_error ? `<p class="error">${esc(req.query.atproto_error)}</p>` : ""}
     <p class="muted">Link a Bluesky or other atproto account to read subscriber-only spaces in atproto apps. You'll sign in with that account to prove it's yours; this License Server only learns its DID, and can't post or read anything as you.</p>
     <p class="muted">Atproto DIDs are public. When an atproto app asks a publisher's space for access, the publisher sees which account is reading.</p>
     <form method="post" action="/account/atproto/link"><label>Handle <input name="handle" placeholder="you.bsky.social" required></label> <button>Sign in to link</button></form>`}
<form method="post" action="/account/logout"><button>Sign out</button></form>`));
});

// Link an atproto account by signing in with it (atproto OAuth; see atproto-oauth.js).
app.post("/account/atproto/link", async (req, res) => {
  const account = sessionAccount(req);
  if (!account) return res.redirect(303, "/account");
  try {
    const { url, state, txn } = await startLink({ issuer: ISSUER, input: req.body.handle });
    for (const [k, t] of atprotoTxns) if (Date.now() - t.at > 10 * 60 * 1000) atprotoTxns.delete(k);
    atprotoTxns.set(state, { ...txn, account });
    res.redirect(303, url);
  } catch (e) {
    res.redirect(303, `${ISSUER}/account?atproto_error=${encodeURIComponent(e.message)}`);
  }
});

// The redirect back from the account's authorization server. The transaction (found by
// `state`) says which OPE account started it. The browser must still be signed in as
// that account, so nobody can send someone else a sign-in link that attaches their
// atproto account to the sender's. The one exception is a local run, whose callback
// lands on 127.0.0.1 (atproto's rule for loopback clients), where the session cookie
// for localhost isn't sent.
app.get("/account/atproto/callback", async (req, res) => {
  const txn = atprotoTxns.get(String(req.query.state || ""));
  if (!txn) return res.redirect(303, `${ISSUER}/account?atproto_error=${encodeURIComponent("unknown or expired sign-in; try again")}`);
  atprotoTxns.delete(String(req.query.state));
  const current = sessionAccount(req);
  if (current ? current !== txn.account : !clientFor(ISSUER).loopback) {
    return res.redirect(303, `${ISSUER}/account?atproto_error=${encodeURIComponent("this sign-in was started from a different account")}`);
  }
  try {
    const { did, handle } = await finishLink({ issuer: ISSUER, txn, query: req.query });
    // One OPE account per atproto account: linking here unlinks it elsewhere.
    for (const [acct, link] of atprotoLinks) if (link.did === did) atprotoLinks.delete(acct);
    atprotoLinks.set(txn.account, { did, handle });
    res.redirect(303, `${ISSUER}/account`);
  } catch (e) {
    res.redirect(303, `${ISSUER}/account?atproto_error=${encodeURIComponent(e.message)}`);
  }
});

// Client metadata for atproto OAuth: the client_id of a deployed License Server.
app.get("/oauth/atproto-client-metadata.json", (_req, res) => {
  res.set("Cache-Control", "public, max-age=600").json(clientMetadata(ISSUER, "OPE License Server"));
});

app.post("/account/atproto/unlink", (req, res) => {
  const account = sessionAccount(req);
  if (account) atprotoLinks.delete(account);
  res.redirect(303, "/account");
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

// ── Persistence hooks ──
// Everything a later request may need, as plain JSON. Expired entries are
// dropped so the saved state stays small. The metadata and Terms caches aren't
// saved: they're refetched as needed.

const PERSISTED = { clients, sessions, transactions, codes, entitlements, grants, refreshTokens, accessTokens, seenProofs, atprotoLinks, atprotoTxns };

function exportState() {
  const t = now();
  const live = {
    codes: ([, c]) => c.expires >= t,
    transactions: ([, x]) => x.expires >= Date.now(),
    seenProofs: ([, expiry]) => expiry >= Date.now(),
    accessTokens: ([, a]) => a.exp >= t,
  };
  return {
    maps: Object.fromEntries(Object.entries(PERSISTED).map(([name, map]) =>
      [name, [...map].filter(live[name] || (() => true))])),
    issuanceLog: issuanceLog.slice(-500),
  };
}

function importState(state) {
  for (const [name, map] of Object.entries(PERSISTED)) {
    map.clear();
    for (const [key, value] of state?.maps?.[name] || []) map.set(key, value);
  }
  issuanceLog.length = 0;
  issuanceLog.push(...(state?.issuanceLog || []));
}

export { app, exportState, importState, issuanceLog, ISSUER, PORT, PROTECTED_RESOURCES, RS_CREDENTIALS, spaceManager, setAtprotoKeyResolver };
