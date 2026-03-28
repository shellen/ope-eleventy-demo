const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const DEFAULT_TTL = 3600;
const MAX_TTL = 86400;

// All grant types from OPE spec v0.1, Section 21
const GRANT_TYPES = [
  "subscription", "per_item", "gift", "institutional", "metered",
  "locale_free", "patronage", "broker", "trial", "rental",
  "bundle", "ad_supported", "early_access", "family",
];

module.exports = function opePlugin(eleventyConfig, options = {}) {
  const {
    siteUrl = "https://example.com",
    publisherName = "My Blog",
    publisherId = null,
    jwtSecret = process.env.OPE_JWT_SECRET || crypto.randomBytes(32).toString("hex"),
    defaultTtl = DEFAULT_TTL,
    maxTtl = MAX_TTL,
    subscribeUrl = null,
    plans = [],
    grantsSupported = ["subscription", "gift", "per_item"],
    brokerSupport = false,
  } = options;

  // ── Global data for templates ──
  eleventyConfig.addGlobalData("ope", {
    siteUrl,
    publisherName,
    publisherId: publisherId || siteUrl,
    defaultTtl,
    maxTtl,
    subscribeUrl: subscribeUrl || `${siteUrl}/subscribe`,
    plans,
    grantsSupported,
    brokerSupport,
  });

  // ── Preview extraction filter ──
  eleventyConfig.addFilter("opePreview", function (content, maxChars) {
    if (maxChars === undefined) maxChars = 280;
    if (!content) return "";
    const stripped = content.replace(/<[^>]+>/g, "");
    if (stripped.length <= maxChars) return stripped;
    return stripped.substring(0, maxChars).replace(/\s+\S*$/, "") + "\u2026";
  });

  // ── Word count filter ──
  eleventyConfig.addFilter("opeWordCount", function (content) {
    if (!content) return 0;
    return content.replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean).length;
  });

  // ── Read time filter ──
  eleventyConfig.addFilter("opeReadTime", function (content) {
    if (!content) return 0;
    const words = content.replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean).length;
    return Math.ceil(words / 250);
  });

  // ── JSON escape filter for safe embedding in JSON templates ──
  eleventyConfig.addFilter("jsonEscape", function (str) {
    if (!str) return "";
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
  });
};

// ── Export grant type list for validation ──
module.exports.GRANT_TYPES = GRANT_TYPES;

// ── Export JWT helpers for serverless functions ──
// Spec §8: Grant token claims (required + optional)
module.exports.createGrant = function (secret, issuer, userId, grantType, opts) {
  if (!opts) opts = {};
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(opts.ttl || DEFAULT_TTL, MAX_TTL);

  const payload = {
    iss: issuer,
    sub: userId,
    scope: opts.scope || ["content:read"],
    grant_type: grantType,
    iat: now,
    exp: now + ttl,
    jti: "grant_" + crypto.randomBytes(8).toString("hex"),
  };

  // Optional claims (spec §8.3)
  if (opts.contentIds) payload.content_ids = opts.contentIds;
  if (opts.meterRemaining != null) payload.meter_remaining = opts.meterRemaining;
  if (opts.institutionalDomain) payload.institutional_domain = opts.institutionalDomain;
  if (opts.brokerId) payload.broker_id = opts.brokerId;
  if (opts.trialExpiresAt != null) payload.trial_expires_at = opts.trialExpiresAt;
  if (opts.rentalExpiresAt != null) payload.rental_expires_at = opts.rentalExpiresAt;
  if (opts.bundleId) payload.bundle_id = opts.bundleId;
  if (opts.groupId) payload.group_id = opts.groupId;
  if (opts.adFree != null) payload.ad_free = opts.adFree;

  return jwt.sign(payload, secret, { algorithm: "HS256" });
};

module.exports.verifyGrant = function (secret, token) {
  try {
    return jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch (e) {
    return null;
  }
};
