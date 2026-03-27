const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const DEFAULT_TTL = 3600;

module.exports = function opePlugin(eleventyConfig, options = {}) {
  const {
    siteUrl = "https://example.com",
    publisherName = "My Blog",
    publisherId = null,
    jwtSecret = process.env.OPE_JWT_SECRET || crypto.randomBytes(32).toString("hex"),
    defaultTtl = DEFAULT_TTL,
    subscribeUrl = null,
    plans = [],
    grantsSupported = ["subscription", "gift", "per_item"],
  } = options;

  // ── Global data for templates ──
  eleventyConfig.addGlobalData("ope", {
    siteUrl,
    publisherName,
    publisherId: publisherId || siteUrl,
    defaultTtl,
    subscribeUrl: subscribeUrl || `${siteUrl}/subscribe`,
    plans,
    grantsSupported,
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

// ── Export JWT helpers for serverless functions ──
module.exports.createGrant = function (secret, issuer, userId, grantType, opts) {
  if (!opts) opts = {};
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: userId,
    scope: ["content:read"],
    grant_type: grantType,
    iat: now,
    exp: now + (opts.ttl || DEFAULT_TTL),
    jti: "grant_" + crypto.randomBytes(8).toString("hex"),
  };
  if (opts.contentIds) payload.content_ids = opts.contentIds;
  if (opts.meterRemaining != null) payload.meter_remaining = opts.meterRemaining;
  return jwt.sign(payload, secret, { algorithm: "HS256" });
};

module.exports.verifyGrant = function (secret, token) {
  try {
    return jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch (e) {
    return null;
  }
};
