#!/usr/bin/env node

// Usage:
//   OPE_JWT_SECRET=mysecret node scripts/create-grant.js
//   OPE_JWT_SECRET=mysecret node scripts/create-grant.js --user alice --type gift --content protocol-economics
//   OPE_JWT_SECRET=mysecret node scripts/create-grant.js --user bob --type metered --meter 5
//   OPE_JWT_SECRET=mysecret node scripts/create-grant.js --user carol --type trial --trial-days 7
//   OPE_JWT_SECRET=mysecret node scripts/create-grant.js --user dave --type per_item --content podcast-open-feeds
//   OPE_JWT_SECRET=mysecret node scripts/create-grant.js --user eve --type family --group household-123

const { createGrant, GRANT_TYPES } = require("../plugins/eleventy-plugin-ope/index.cjs");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

if (args.includes("--help")) {
  console.log(`
  OPE Grant Token Generator (spec v0.1)

  Usage: OPE_JWT_SECRET=secret node scripts/create-grant.cjs [options]

  Options:
    --user <id>          User identifier (default: test-user)
    --type <grant_type>  Grant type (default: subscription)
    --ttl <seconds>      Token lifetime (default: 3600)
    --content <id>       Content ID (for per_item, rental, bundle)
    --meter <count>      Remaining articles (for metered)
    --trial-days <days>  Trial duration in days (for trial)
    --bundle <id>        Bundle identifier (for bundle)
    --group <id>         Group/household ID (for family)
    --ad-free            Ad-free flag (for ad_supported)
    --help               Show this help

  Grant types: ${GRANT_TYPES.join(", ")}
`);
  process.exit(0);
}

const secret = process.env.OPE_JWT_SECRET;
if (!secret) {
  console.error("Error: OPE_JWT_SECRET environment variable is required");
  console.error("  OPE_JWT_SECRET=mysecret node scripts/create-grant.cjs");
  process.exit(1);
}

const issuer = process.env.OPE_PUBLISHER_ID || "https://ope-demo.netlify.app";
const userId = flag("user", "test-user");
const grantType = flag("type", "subscription");
const ttl = parseInt(flag("ttl", "3600"), 10);

if (!GRANT_TYPES.includes(grantType)) {
  console.error(`Error: Unknown grant type "${grantType}"`);
  console.error(`  Valid types: ${GRANT_TYPES.join(", ")}`);
  process.exit(1);
}

const opts = { ttl };

const contentId = flag("content", null);
if (contentId) opts.contentIds = [contentId];

const meter = flag("meter", null);
if (meter) opts.meterRemaining = parseInt(meter, 10);

const trialDays = flag("trial-days", null);
if (trialDays) opts.trialExpiresAt = Math.floor(Date.now() / 1000) + parseInt(trialDays, 10) * 86400;

const bundleId = flag("bundle", null);
if (bundleId) opts.bundleId = bundleId;

const groupId = flag("group", null);
if (groupId) opts.groupId = groupId;

if (args.includes("--ad-free")) opts.adFree = true;

const token = createGrant(secret, issuer, userId, grantType, opts);

console.log("\n  OPE Grant Token Created (spec v0.1)\n");
console.log(`  User:       ${userId}`);
console.log(`  Type:       ${grantType}`);
console.log(`  TTL:        ${ttl}s`);
if (contentId) console.log(`  Content:    ${contentId}`);
if (meter) console.log(`  Meter:      ${meter} remaining`);
if (trialDays) console.log(`  Trial:      ${trialDays} days`);
if (bundleId) console.log(`  Bundle:     ${bundleId}`);
if (groupId) console.log(`  Group:      ${groupId}`);
if (opts.adFree) console.log(`  Ad-free:    yes`);
console.log(`\n  Token:\n`);
console.log(`  ${token}`);
console.log(`\n  Test with:\n`);
console.log(`  curl -H "Authorization: Bearer ${token}" http://localhost:8888/api/content/protocol-economics\n`);
