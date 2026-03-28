// ─────────────────────────────────────────────────────────────
// OPE Gateway — sample implementation
//
// A gateway sits between readers and publishers. It:
//   1. Authenticates subscribers (simplified here with an API key)
//   2. Issues JWT grant tokens that readers present to publishers
//   3. Refreshes expiring grants
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

// ── In-memory stores (replace with a real database in production) ───

// Active subscriptions: userId → { plan, created, active }
const subscriptions = new Map();

// Revoked token IDs
const revokedTokens = new Set();

// ── Helpers ─────────────────────────────────────────────────────────

function makeGrant(userId, grantType, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttl || DEFAULT_TTL;

  const payload = {
    iss: ISSUER,
    sub: userId,
    scope: ["content:read"],
    grant_type: grantType,
    iat: now,
    exp: now + ttl,
    jti: "grant_" + crypto.randomBytes(8).toString("hex"),
  };

  if (opts.contentIds) payload.content_ids = opts.contentIds;
  if (opts.meterRemaining != null) payload.meter_remaining = opts.meterRemaining;

  return { token: jwt.sign(payload, SECRET, { algorithm: "HS256" }), payload };
}

function decodeToken(token) {
  try {
    return jwt.verify(token, SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

// ── POST /api/entitlement/grant ─────────────────────────────────────
// Request body:
//   { user_id, grant_type, content_ids?, meter_remaining?, ttl? }
//
// In production this would check payment status, subscription records,
// etc. Here we auto-create a subscription for demonstration purposes.

app.post("/api/entitlement/grant", (req, res) => {
  const { user_id, grant_type = "subscription", content_ids, meter_remaining, ttl } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "user_id is required" });
  }

  const validTypes = ["subscription", "per_item", "metered", "gift"];
  if (!validTypes.includes(grant_type)) {
    return res.status(400).json({ error: `Invalid grant_type. Must be one of: ${validTypes.join(", ")}` });
  }

  // Auto-register subscription (in production: verify payment first)
  if (!subscriptions.has(user_id)) {
    subscriptions.set(user_id, { plan: "monthly", created: new Date().toISOString(), active: true });
    console.log(`  [gateway] New subscription created for ${user_id}`);
  }

  const sub = subscriptions.get(user_id);
  if (!sub.active) {
    return res.status(403).json({ error: "Subscription is inactive" });
  }

  const opts = { ttl };
  if (content_ids) opts.contentIds = content_ids;
  if (meter_remaining != null) opts.meterRemaining = meter_remaining;

  const { token, payload } = makeGrant(user_id, grant_type, opts);

  console.log(`  [gateway] Grant issued: ${grant_type} for ${user_id} (jti: ${payload.jti})`);

  res.json({
    status: "granted",
    token,
    grant_type: payload.grant_type,
    expires_at: new Date(payload.exp * 1000).toISOString(),
    token_id: payload.jti,
  });
});

// ── POST /api/entitlement/refresh ───────────────────────────────────
// Request body: { token }
// Returns a fresh token if the original is still valid and not revoked.

app.post("/api/entitlement/refresh", (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: "token is required" });
  }

  const decoded = decodeToken(token);
  if (!decoded) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  if (revokedTokens.has(decoded.jti)) {
    return res.status(403).json({ error: "Token has been revoked" });
  }

  // Check subscription is still active
  const sub = subscriptions.get(decoded.sub);
  if (!sub || !sub.active) {
    return res.status(403).json({ error: "Subscription is no longer active" });
  }

  // Issue a fresh grant with the same parameters
  const opts = {};
  if (decoded.content_ids) opts.contentIds = decoded.content_ids;
  if (decoded.meter_remaining != null) opts.meterRemaining = decoded.meter_remaining;

  const { token: newToken, payload } = makeGrant(decoded.sub, decoded.grant_type, opts);

  // Revoke the old token
  revokedTokens.add(decoded.jti);

  console.log(`  [gateway] Grant refreshed for ${decoded.sub} (old: ${decoded.jti} → new: ${payload.jti})`);

  res.json({
    status: "refreshed",
    token: newToken,
    grant_type: payload.grant_type,
    expires_at: new Date(payload.exp * 1000).toISOString(),
    token_id: payload.jti,
  });
});

// ── POST /api/entitlement/revoke ────────────────────────────────────
// Request body: { token }
// Marks the token as revoked.

app.post("/api/entitlement/revoke", (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: "token is required" });
  }

  const decoded = decodeToken(token);
  if (!decoded) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  revokedTokens.add(decoded.jti);

  console.log(`  [gateway] Grant revoked: ${decoded.jti} for ${decoded.sub}`);

  res.json({ status: "revoked", token_id: decoded.jti });
});

// ── GET /.well-known/ope ────────────────────────────────────────────
// OPE discovery document for the gateway itself.

app.get("/.well-known/ope", (_req, res) => {
  res.json({
    version: "0.1",
    entitlement: {
      grant_url: `${ISSUER}/api/entitlement/grant`,
      refresh_url: `${ISSUER}/api/entitlement/refresh`,
      revocation_url: `${ISSUER}/api/entitlement/revoke`,
      token_format: "jwt",
      token_mode: "simple",
      default_ttl_seconds: DEFAULT_TTL,
    },
    grants_supported: ["subscription", "gift", "per_item", "metered"],
  });
});

// ── Start ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  OPE Gateway running on http://localhost:${PORT}`);
  console.log(`  Discovery:  http://localhost:${PORT}/.well-known/ope`);
  console.log(`  Secret:     ${SECRET === "dev-secret-change-me" ? "(using default dev secret)" : "(custom secret set)"}\n`);
});
