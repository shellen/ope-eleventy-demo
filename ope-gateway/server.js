// ─────────────────────────────────────────────────────────────
// OPE Gateway — sample implementation (spec v0.1)
//
// A gateway sits between readers and publishers. It:
//   1. Authenticates subscribers (simplified here with an API key)
//   2. Issues JWT grant tokens that readers present to publishers
//   3. Refreshes expiring grants (with refresh token rotation)
//   4. Revokes grants on cancellation
//
// Endpoints (matches /.well-known/ope discovery document):
//   POST /api/entitlement/grant    — issue a new grant token
//   POST /api/entitlement/refresh  — refresh an existing grant
//   POST /api/entitlement/revoke   — revoke a grant
//   GET  /.well-known/ope          — OPE discovery document
//
// Environment:
//   OPE_JWT_SECRET  — shared secret (must match the publisher's secret)
//   PORT            — server port (default 4000)
//
// Spec reference: https://feedspec.org/ope
// ─────────────────────────────────────────────────────────────

import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const SECRET = process.env.OPE_JWT_SECRET || "dev-secret-change-me";
const ISSUER = process.env.OPE_GATEWAY_ISSUER || `http://localhost:${PORT}`;
const DEFAULT_TTL = 3600; // 1 hour
const MAX_TTL = 86400;    // 24 hours

// ── In-memory stores (replace with a real database in production) ───

// Active subscriptions: userId → { plan, created, active }
const subscriptions = new Map();

// Revoked token IDs (jti → reason)
const revokedTokens = new Map();

// Refresh tokens: refreshToken → { userId, grantType, opts }
const refreshTokens = new Map();

// ── Grant types from the spec (Section 21) ──────────────────────────

const GRANT_TYPES = [
  "subscription", "per_item", "gift", "institutional", "metered",
  "locale_free", "patronage", "broker", "trial", "rental",
  "bundle", "ad_supported", "early_access", "family",
];

// ── Helpers ─────────────────────────────────────────────────────────

function makeRefreshToken() {
  return "ope_rt_" + crypto.randomBytes(16).toString("hex");
}

function makeGrant(userId, grantType, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(opts.ttl || DEFAULT_TTL, MAX_TTL);

  const payload = {
    iss: ISSUER,
    sub: userId,
    scope: ["content:read"],
    grant_type: grantType,
    iat: now,
    exp: now + ttl,
    jti: "grant_" + crypto.randomBytes(8).toString("hex"),
  };

  // Per-item / bundle / rental: scope to content IDs (spec §8.3)
  if (opts.contentIds) payload.content_ids = opts.contentIds;

  // Metered: remaining count (spec §8.3)
  if (opts.meterRemaining != null) payload.meter_remaining = opts.meterRemaining;

  // Trial: separate expiry (spec §8.3)
  if (opts.trialExpiresAt != null) payload.trial_expires_at = opts.trialExpiresAt;

  // Rental: rental-specific expiry (spec §8.3)
  if (opts.rentalExpiresAt != null) payload.rental_expires_at = opts.rentalExpiresAt;

  // Bundle: bundle identifier (spec §8.3)
  if (opts.bundleId) payload.bundle_id = opts.bundleId;

  // Family: group identifier (spec §8.3)
  if (opts.groupId) payload.group_id = opts.groupId;

  // Ad-supported: ad-free flag (spec §8.3)
  if (opts.adFree != null) payload.ad_free = opts.adFree;

  const token = jwt.sign(payload, SECRET, { algorithm: "HS256" });

  // Issue a refresh token (spec §12.3)
  const refreshToken = makeRefreshToken();
  refreshTokens.set(refreshToken, { userId, grantType, opts });

  return { token, payload, refreshToken };
}

function decodeToken(token) {
  try {
    return jwt.verify(token, SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

// Spec-aligned error response (Section 10.3)
function errorResponse(res, status, error, errorDescription, extra = {}) {
  return res.status(status).json({
    error,
    error_description: errorDescription,
    ope_discovery: `${ISSUER}/.well-known/ope`,
    ...extra,
  });
}

// ── POST /api/entitlement/grant ─────────────────────────────────────
// Request body:
//   { user_id, grant_type, content_ids?, meter_remaining?, ttl?,
//     trial_expires_at?, rental_expires_at?, bundle_id?, group_id?, ad_free? }
//
// In production this would check payment status, subscription records,
// etc. Here we auto-create a subscription for demonstration purposes.

app.post("/api/entitlement/grant", (req, res) => {
  const {
    user_id, grant_type = "subscription", content_ids,
    meter_remaining, ttl, trial_expires_at, rental_expires_at,
    bundle_id, group_id, ad_free,
  } = req.body;

  if (!user_id) {
    return errorResponse(res, 400, "invalid_request", "user_id is required");
  }

  if (!GRANT_TYPES.includes(grant_type)) {
    return errorResponse(res, 400, "invalid_request",
      `Invalid grant_type. Must be one of: ${GRANT_TYPES.join(", ")}`);
  }

  // Auto-register subscription (in production: verify payment first)
  if (!subscriptions.has(user_id)) {
    subscriptions.set(user_id, { plan: "monthly", created: new Date().toISOString(), active: true });
    console.log(`  [gateway] New subscription created for ${user_id}`);
  }

  const sub = subscriptions.get(user_id);
  if (!sub.active) {
    return errorResponse(res, 403, "not_entitled", "Subscription is inactive");
  }

  const opts = { ttl };
  if (content_ids) opts.contentIds = content_ids;
  if (meter_remaining != null) opts.meterRemaining = meter_remaining;
  if (trial_expires_at != null) opts.trialExpiresAt = trial_expires_at;
  if (rental_expires_at != null) opts.rentalExpiresAt = rental_expires_at;
  if (bundle_id) opts.bundleId = bundle_id;
  if (group_id) opts.groupId = group_id;
  if (ad_free != null) opts.adFree = ad_free;

  const { token, payload, refreshToken } = makeGrant(user_id, grant_type, opts);

  console.log(`  [gateway] Grant issued: ${grant_type} for ${user_id} (jti: ${payload.jti})`);

  // Response matches spec §22 Step 5
  res.json({
    grant_token: token,
    refresh_token: refreshToken,
    expires_in: payload.exp - payload.iat,
    grant_type: payload.grant_type,
    scope: payload.scope,
    token_id: payload.jti,
  });
});

// ── POST /api/entitlement/refresh ───────────────────────────────────
// Request body: { refresh_token, client_id? }
// Returns a fresh grant token + new refresh token (rotation per spec §12.3).

app.post("/api/entitlement/refresh", (req, res) => {
  const { refresh_token, client_id } = req.body;

  if (!refresh_token) {
    return errorResponse(res, 400, "invalid_request", "refresh_token is required");
  }

  const stored = refreshTokens.get(refresh_token);
  if (!stored) {
    return errorResponse(res, 401, "invalid_token", "Invalid or expired refresh token");
  }

  // Check subscription is still active
  const sub = subscriptions.get(stored.userId);
  if (!sub || !sub.active) {
    return errorResponse(res, 403, "not_entitled", "Subscription is no longer active");
  }

  // Invalidate the old refresh token (rotation — spec §12.3)
  refreshTokens.delete(refresh_token);

  // Issue a fresh grant with the same parameters
  const { token: newToken, payload, refreshToken: newRefreshToken } =
    makeGrant(stored.userId, stored.grantType, stored.opts);

  console.log(`  [gateway] Grant refreshed for ${stored.userId} (new jti: ${payload.jti})`);

  // Response matches spec §12.3
  res.json({
    grant_token: newToken,
    refresh_token: newRefreshToken,
    expires_in: payload.exp - payload.iat,
    grant_type: payload.grant_type,
    scope: payload.scope,
    token_id: payload.jti,
  });
});

// ── POST /api/entitlement/revoke ────────────────────────────────────
// Request body: { jti, reason? } or { token }
// Spec §12.2: revocation by jti with optional reason.

app.post("/api/entitlement/revoke", (req, res) => {
  let { jti, reason, token } = req.body;

  // Support both jti-based and token-based revocation
  if (!jti && token) {
    const decoded = decodeToken(token);
    if (!decoded) {
      return errorResponse(res, 401, "invalid_token", "Invalid or expired token");
    }
    jti = decoded.jti;
  }

  if (!jti) {
    return errorResponse(res, 400, "invalid_request", "jti or token is required");
  }

  revokedTokens.set(jti, reason || "user_requested");

  console.log(`  [gateway] Grant revoked: ${jti} (reason: ${reason || "user_requested"})`);

  // Response matches spec §12.2
  res.json({ revoked: true, jti });
});

// ── GET /.well-known/ope ────────────────────────────────────────────
// OPE discovery document — spec §6.

app.get("/.well-known/ope", (_req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.set("Access-Control-Allow-Origin", "*");
  res.json({
    version: "0.1",
    entitlement: {
      grant_url: `${ISSUER}/api/entitlement/grant`,
      refresh_url: `${ISSUER}/api/entitlement/refresh`,
      revocation_url: `${ISSUER}/api/entitlement/revoke`,
      token_format: "jwt",
      token_mode: "simple",
      default_ttl_seconds: DEFAULT_TTL,
      max_ttl_seconds: MAX_TTL,
    },
    content: {
      endpoint_template: `${ISSUER}/api/content/{id}`,
      formats_available: ["html"],
    },
    metadata: {
      subscribe_url: `${ISSUER}/subscribe`,
      plans: [
        { id: "monthly", name: "Monthly", currency: "USD", amount: 500 },
        { id: "annual", name: "Annual", currency: "USD", amount: 5000 },
      ],
    },
    grants_supported: GRANT_TYPES,
    broker_support: false,
  });
});

// ── CORS preflight for all routes ───────────────────────────────────
// Spec §11.5: CORS requirements for web clients.

app.options("*", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin": req.headers.origin || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  });
  res.sendStatus(204);
});

// ── Start ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  OPE Gateway running on http://localhost:${PORT}`);
  console.log(`  Discovery:  http://localhost:${PORT}/.well-known/ope`);
  console.log(`  Secret:     ${SECRET === "dev-secret-change-me" ? "(using default dev secret)" : "(custom secret set)"}`);
  console.log(`  Spec:       https://feedspec.org/ope (v0.1)\n`);
});
