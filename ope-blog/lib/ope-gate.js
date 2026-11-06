// ABOUTME: OPE v0.2 Resource Server checks (spec §11.2), independent of any web framework.
// ABOUTME: The Express server and the Netlify function both call check() before serving a gated post.

import {
  jwtVerify,
  decodeJwt,
  decodeProtectedHeader,
  createRemoteJWKSet,
  calculateJwkThumbprint,
  importJWK,
} from "jose";
import { createHash } from "node:crypto";

const TOKEN_TYPE = "license+jwt"; // spec §9.1
const DPOP_MAX_AGE_SECONDS = 120;

export function createGate(config, options = {}) {
  // Local-validation tolerance (spec §12.3). A token with more lifetime left than
  // this is checked with the License Server's /introspect, so a revoked token stops
  // working at once. Without an introspection credential the tolerance must cover
  // the License Server's whole token lifetime (spec §13.4).
  const introspection = options.introspection || null;
  const tolerance = introspection ? options.toleranceSeconds ?? 300 : Infinity;
  const origin = new URL(config.siteUrl).origin;

  const issuers = new Map(); // issuer → { metadata, jwks, fetchedAt }
  const seenProofs = new Map(); // DPoP proof jti → expiry, to refuse replays
  const usage = new Map(); // limit Entitlements: sub|resource|window → count

  // ── Challenges and errors (spec §11.4) ──
  function challenge(scope, error, description) {
    const params = [`ope_scope="${scope}"`];
    if (error) params.push(`error="${error}"`);
    if (description) params.push(`error_description="${description}"`);
    return [`DPoP algs="ES256", ${params.join(", ")}`, `License ${params.join(", ")}`];
  }

  function refuse(status, scope, error, description, extra = {}) {
    return {
      ok: false,
      status,
      error,
      description,
      headers: { "WWW-Authenticate": challenge(scope, error, description), ...extra },
    };
  }

  // ── License Server metadata and keys, cached ──
  async function issuerInfo(issuer) {
    const cached = issuers.get(issuer);
    if (cached && Date.now() - cached.fetchedAt < 24 * 3600 * 1000) return cached;
    // RFC 8414 §3.1 (these issuers have no path component)
    const res = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
    if (!res.ok) throw new Error(`License Server metadata ${res.status}`);
    const metadata = await res.json();
    if (metadata.issuer !== issuer) throw new Error("License Server metadata issuer mismatch");
    const info = {
      metadata,
      // Refetch keys at least every 5 minutes, and at once on an unknown kid (spec §7.3).
      jwks: createRemoteJWKSet(new URL(metadata.jwks_uri), {
        cacheMaxAge: 5 * 60 * 1000,
        cooldownDuration: 30 * 1000,
      }),
      fetchedAt: Date.now(),
    };
    issuers.set(issuer, info);
    return info;
  }

  // ── DPoP proof (RFC 9449 §4.3) ──
  async function verifyProof(proof, { method, htu, accessToken, jkt }) {
    if (!proof) throw new Error("missing DPoP proof");
    const header = decodeProtectedHeader(proof);
    if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || !header.jwk || header.jwk.d) {
      throw new Error("malformed DPoP proof header");
    }
    const key = await importJWK(header.jwk, "ES256");
    const { payload } = await jwtVerify(proof, key, {
      typ: "dpop+jwt",
      algorithms: ["ES256"],
      maxTokenAge: `${DPOP_MAX_AGE_SECONDS}s`,
      clockTolerance: 30,
    });
    if (payload.htm !== method) throw new Error("DPoP htm mismatch");
    if (payload.htu !== htu) throw new Error("DPoP htu mismatch");
    const ath = createHash("sha256").update(accessToken).digest("base64url");
    if (payload.ath !== ath) throw new Error("DPoP ath mismatch");
    if (await calculateJwkThumbprint(header.jwk, "sha256") !== jkt) throw new Error("DPoP key does not match cnf");
    const now = Date.now();
    for (const [jti, exp] of seenProofs) if (exp < now) seenProofs.delete(jti);
    if (!payload.jti || seenProofs.has(payload.jti)) throw new Error("DPoP proof replayed");
    seenProofs.set(payload.jti, now + 2 * DPOP_MAX_AGE_SECONDS * 1000);
  }

  // ── Introspection (RFC 7662, with RSL's resource/permitted: spec §12.4) ──
  async function introspect(issuerMeta, token, asset) {
    const auth = Buffer.from(`${introspection.clientId}:${introspection.clientSecret}`).toString("base64");
    const res = await fetch(issuerMeta.introspection_endpoint, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, resource: asset }),
    });
    if (!res.ok) throw new Error(`introspection ${res.status}`);
    return res.json();
  }

  function scopeFor(asset) {
    return config.scopes
      .filter((s) => asset.startsWith(s.scope))
      .sort((a, b) => b.scope.length - a.scope.length)[0];
  }

  function periodWindow(period) {
    const d = new Date().toISOString();
    if (period === "P1D") return d.slice(0, 10);
    if (period === "P1Y") return d.slice(0, 4);
    return d.slice(0, 7); // P1M and anything else: calendar month
  }

  // ── The checks, in spec §11.2 order ──
  // request: { method, url (as requested, absolute), headers (lower-case names) }
  async function check({ method, url, headers }) {
    const scopeEntry = { scope: config.scopes[0].scope };

    // Encoded path separators are ambiguous across servers: refuse them (spec §5.3).
    const rawPath = url.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0];
    if (/%2f|%5c/i.test(rawPath)) {
      return { ok: false, status: 400, error: "invalid_request", description: "encoded path separator", headers: {} };
    }

    // Normalize before matching (spec §5.3): URL parsing removes dot-segments and
    // lowercases the host. The Asset identifier has no query or fragment (spec §5.2).
    const parsed = new URL(url);
    const asset = parsed.origin + parsed.pathname;
    const scope = (scopeFor(asset) || scopeEntry).scope;

    // No credentials, or a scheme OPE doesn't accept (Bearer: spec §14 downgrade):
    // 402 says the post is for sale; the challenge carries no error code (spec §11.4).
    const match = (headers.authorization || "").match(/^(DPoP|License)\s+(\S+)$/i);
    if (!match) return refuse(402, scope);
    const scheme = match[1].toLowerCase() === "dpop" ? "DPoP" : "License";
    const token = match[2];

    // 1–2. Signature from a listed issuer; typ, iss, aud, exp, iat.
    let claims;
    let issuer;
    try {
      if (decodeProtectedHeader(token).typ !== TOKEN_TYPE) throw new Error("not a License Token");
      issuer = decodeJwt(token).iss;
      if (!config.licenseServers.includes(issuer)) throw new Error("issuer not listed in our metadata");
    } catch (e) {
      return refuse(401, scope, "invalid_token", e.message);
    }
    let info;
    try {
      info = await issuerInfo(issuer);
    } catch {
      return { ok: false, status: 503, error: "temporarily_unavailable", description: "License Server unreachable", headers: { "Retry-After": "30" } };
    }
    try {
      ({ payload: claims } = await jwtVerify(token, info.jwks, {
        issuer,
        audience: origin,
        typ: TOKEN_TYPE,
        algorithms: ["ES256"],
        requiredClaims: ["exp", "iat", "jti", "sub", "client_id", "resource", "publisher", "terms", "entitlement"],
      }));
    } catch (e) {
      return refuse(401, scope, "invalid_token", e.code || e.message);
    }

    // 3. The token's resource covers this Asset, as coverage says (spec §10.4),
    //    and it was issued for this publisher (spec §5.8).
    const ent = claims.entitlement || {};
    const covers = ent.coverage === "item"
      ? claims.resource === asset
      : ent.coverage === "collection" && claims.resource.endsWith("/") && asset.startsWith(claims.resource);
    if (!covers || claims.publisher !== config.publisher) {
      return refuse(403, scope, "insufficient_scope", "token does not cover this post");
    }

    // 4. The Entitlement permits serving: status alone never does; rentals end.
    const now = Math.floor(Date.now() / 1000);
    if (ent.type !== "access" && ent.type !== "limit") {
      return refuse(403, scope, "no_entitlement", "this Entitlement does not include access");
    }
    if (ent.duration === "rental" && !(now < ent.rental_expires_at)) {
      return refuse(403, scope, "no_entitlement", "rental has ended");
    }

    // 5. Sender constraint: a bound token needs its DPoP proof; DPoP needs a bound token.
    if (claims.cnf && claims.cnf.jkt) {
      if (scheme !== "DPoP") return refuse(401, scope, "invalid_token", "bound token presented without proof");
      try {
        await verifyProof(headers.dpop, { method, htu: asset, accessToken: token, jkt: claims.cnf.jkt });
      } catch (e) {
        return refuse(401, scope, "invalid_token", e.message);
      }
    } else if (scheme === "DPoP") {
      return refuse(401, scope, "invalid_token", "DPoP scheme with an unbound token");
    }

    // 6. Revocation: introspect unless the token is within our tolerance (spec §12.3).
    if (claims.exp - now > tolerance) {
      try {
        const result = await introspect(info.metadata, token, asset);
        if (!result.active) {
          return refuse(401, scope, "invalid_token", `inactive: ${result.revocation_reason || "revoked"}`);
        }
        if (result.permitted === false) return refuse(403, scope, "insufficient_scope", "not permitted");
      } catch {
        return { ok: false, status: 503, error: "temporarily_unavailable", description: "introspection failed", headers: { "Retry-After": "30" } };
      }
    }

    // A limit Entitlement is counted here; the License Server's number is only a snapshot.
    const extraHeaders = {};
    if (ent.type === "limit") {
      const key = `${claims.sub}|${claims.resource}|${periodWindow(ent.period)}`;
      const used = (usage.get(key) || 0) + 1;
      if (used > ent.quota) return refuse(403, scope, "quota_exceeded", "monthly limit reached");
      usage.set(key, used);
      extraHeaders["Entitlement-Remaining"] = String(ent.quota - used);
    }

    return { ok: true, status: 200, asset, claims, headers: extraHeaders };
  }

  return { check };
}
