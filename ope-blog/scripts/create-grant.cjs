#!/usr/bin/env node

// Usage:
//   OPE_JWT_SECRET=mysecret node scripts/create-grant.js
//   OPE_JWT_SECRET=mysecret node scripts/create-grant.js --user alice --type gift --content protocol-economics
//   OPE_JWT_SECRET=mysecret node scripts/create-grant.js --user bob --type metered --meter 5

const { createGrant } = require("../plugins/eleventy-plugin-ope/index.cjs");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const secret = process.env.OPE_JWT_SECRET;
if (!secret) {
  console.error("Error: OPE_JWT_SECRET environment variable is required");
  console.error("  OPE_JWT_SECRET=mysecret node scripts/create-grant.js");
  process.exit(1);
}

const issuer = process.env.OPE_PUBLISHER_ID || "https://ope-demo.netlify.app";
const userId = flag("user", "test-user");
const grantType = flag("type", "subscription");
const ttl = parseInt(flag("ttl", "3600"), 10);

const opts = { ttl };

const contentId = flag("content", null);
if (contentId) opts.contentIds = [contentId];

const meter = flag("meter", null);
if (meter) opts.meterRemaining = parseInt(meter, 10);

const token = createGrant(secret, issuer, userId, grantType, opts);

console.log("\n  OPE Grant Token Created\n");
console.log(`  User:       ${userId}`);
console.log(`  Type:       ${grantType}`);
console.log(`  TTL:        ${ttl}s`);
if (contentId) console.log(`  Content:    ${contentId}`);
if (meter) console.log(`  Meter:      ${meter} remaining`);
console.log(`\n  Token:\n`);
console.log(`  ${token}`);
console.log(`\n  Test with:\n`);
console.log(`  curl -H "Authorization: Bearer ${token}" http://localhost:8888/api/content/protocol-economics\n`);
