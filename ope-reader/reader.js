#!/usr/bin/env node

// ─────────────────────────────────────────────────────────────
// OPE Reader — minimal demo (spec v0.1)
//
// Shows the full OPE flow from a reader's perspective:
//   1. Discover publisher capabilities via /.well-known/ope
//   2. Fetch the JSON Feed and list items (free vs. gated)
//   3. Acquire a grant token from the gateway
//   4. Use the grant to fetch full gated content from the publisher
//   5. Refresh the grant (with refresh token rotation)
//   6. Revoke the grant
//
// Usage:
//   node reader.js                          # use defaults
//   node reader.js --publisher http://localhost:8080
//   node reader.js --gateway http://localhost:4000
//   node reader.js --user alice --content protocol-economics
//
// No dependencies — uses only built-in Node.js fetch API (Node 18+)
// Spec reference: https://feedspec.org/ope
// ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PUBLISHER = flag("publisher", "http://localhost:8080");
const GATEWAY = flag("gateway", "http://localhost:4000");
const USER_ID = flag("user", "demo-reader");
const CONTENT_ID = flag("content", null); // null = pick first gated item

// ── Helpers ─────────────────────────────────────────────────────────

function hr(label) {
  console.log(`\n${"─".repeat(60)}`);
  if (label) console.log(`  ${label}`);
  console.log(`${"─".repeat(60)}\n`);
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

// Format a price from smallest currency unit (spec §9.1.1)
function formatPrice(price) {
  if (!price) return null;
  return `$${(price.amount / 100).toFixed(2)} ${price.currency}`;
}

// ── Step 1: Discover publisher OPE config ───────────────────────────
// Spec §6: Fetch /.well-known/ope and cache the discovery document.

async function discoverPublisher() {
  hr("Step 1 — Discover publisher via /.well-known/ope");

  const url = `${PUBLISHER}/.well-known/ope`;
  console.log(`  GET ${url}\n`);

  const discovery = await fetchJSON(url);

  console.log(`  Publisher OPE config:`);
  console.log(`    Version:          ${discovery.version}`);
  console.log(`    Token mode:       ${discovery.entitlement?.token_mode} (${discovery.entitlement?.token_format})`);
  console.log(`    Content endpoint: ${discovery.content?.endpoint_template}`);
  if (discovery.content?.batch_endpoint) {
    console.log(`    Batch endpoint:   ${discovery.content.batch_endpoint}`);
  }
  console.log(`    Default TTL:      ${discovery.entitlement?.default_ttl_seconds}s`);
  if (discovery.entitlement?.max_ttl_seconds) {
    console.log(`    Max TTL:          ${discovery.entitlement.max_ttl_seconds}s`);
  }
  console.log(`    Grants supported: ${discovery.grants_supported?.join(", ")}`);
  if (discovery.broker_support) {
    console.log(`    Broker support:   yes`);
  }

  if (discovery.metadata?.plans?.length) {
    console.log(`    Plans:`);
    for (const plan of discovery.metadata.plans) {
      console.log(`      - ${plan.name}: $${(plan.amount / 100).toFixed(2)} ${plan.currency}`);
    }
  }

  return discovery;
}

// ── Step 2: Fetch the JSON Feed ─────────────────────────────────────
// Spec §9.1: Parse feed, detect OPE extensions, extract content_metadata.

async function fetchFeed() {
  hr("Step 2 — Fetch the JSON Feed");

  const url = `${PUBLISHER}/feed.json`;
  console.log(`  GET ${url}\n`);

  const feed = await fetchJSON(url);

  console.log(`  Feed: "${feed.title}"`);
  console.log(`  Items: ${feed.items.length}\n`);

  for (const item of feed.items) {
    const gated = item.extensions?.ope != null;
    const label = gated ? "[GATED]" : "[FREE] ";
    const preview = gated
      ? item.content_text?.substring(0, 80) + "..."
      : item.content_html?.replace(/<[^>]+>/g, "").substring(0, 80) + "...";

    console.log(`  ${label} ${item.title}`);
    console.log(`           ${preview}`);
    if (gated) {
      const ope = item.extensions.ope;
      const meta = ope.content_metadata || {};

      // Show resource type (spec §9.1.1)
      const type = meta.resource_type || "article";
      const details = [];
      if (meta.word_count) details.push(`${meta.word_count} words`);
      if (meta.estimated_read_time_minutes) details.push(`${meta.estimated_read_time_minutes} min read`);
      if (meta.duration_seconds) details.push(`${Math.floor(meta.duration_seconds / 60)}m ${meta.duration_seconds % 60}s`);
      if (meta.per_item_price) details.push(formatPrice(meta.per_item_price));

      console.log(`           Content ID: ${ope.content_id} (${type})`);
      if (details.length) console.log(`           ${details.join(" | ")}`);
      if (meta.unlock_cta) console.log(`           CTA: ${meta.unlock_cta}`);
      if (meta.unlock_url) console.log(`           Unlock: ${meta.unlock_url}`);
    }
    console.log();
  }

  return feed;
}

// ── Step 3: Acquire a grant from the gateway ────────────────────────
// Spec §22 Step 5: Request an entitlement grant.

async function acquireGrant(grantType = "subscription", contentIds = null) {
  hr("Step 3 — Acquire a grant token from the gateway");

  const url = `${GATEWAY}/api/entitlement/grant`;
  const body = { user_id: USER_ID, grant_type: grantType };
  if (contentIds) body.content_ids = contentIds;

  console.log(`  POST ${url}`);
  console.log(`  Body: ${JSON.stringify(body)}\n`);

  const result = await fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  console.log(`  Grant type:     ${result.grant_type}`);
  console.log(`  Scope:          ${(result.scope || []).join(", ")}`);
  console.log(`  Expires in:     ${result.expires_in}s`);
  console.log(`  Token ID:       ${result.token_id}`);
  console.log(`  Grant token:    ${result.grant_token.substring(0, 40)}...`);
  console.log(`  Refresh token:  ${result.refresh_token.substring(0, 20)}...`);

  return result;
}

// ── Step 4: Fetch gated content using the grant ─────────────────────
// Spec §10.1: Retrieve content with Bearer token.

async function fetchGatedContent(discovery, contentId, token) {
  hr("Step 4 — Fetch gated content from the publisher");

  // Build the content URL from the discovery template (spec §6)
  const template = discovery.content?.endpoint_template || `${PUBLISHER}/api/content/{id}`;
  const url = template.replace("{id}", contentId);

  console.log(`  GET ${url}`);
  console.log(`  Authorization: Bearer ${token.substring(0, 30)}...\n`);

  const content = await fetchJSON(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  console.log(`  Content received!`);
  console.log(`  Title:         ${content.title}`);
  if (content.resource_type) console.log(`  Resource type: ${content.resource_type}`);
  console.log(`  Published:     ${content.published}`);

  // Handle media content (spec §10.1 — podcast episodes, video, etc.)
  if (content.media) {
    console.log(`\n  Media:`);
    console.log(`    URL:       ${content.media.url?.substring(0, 60)}...`);
    console.log(`    Type:      ${content.media.mime_type}`);
    if (content.media.size_bytes) console.log(`    Size:      ${(content.media.size_bytes / 1048576).toFixed(1)} MB`);
    if (content.media.duration_seconds) {
      const m = Math.floor(content.media.duration_seconds / 60);
      const s = content.media.duration_seconds % 60;
      console.log(`    Duration:  ${m}m ${s}s`);
    }
    if (content.media_alternatives?.length) {
      console.log(`    Alternatives: ${content.media_alternatives.length} additional format(s)`);
    }
  }

  // Show a preview of the HTML content (strip tags)
  if (content.content_html) {
    const plainText = content.content_html.replace(/<[^>]+>/g, "");
    const preview = plainText.substring(0, 300);
    console.log(`\n  Preview:\n`);
    console.log(`  ${preview}${plainText.length > 300 ? "..." : ""}`);
  }

  return content;
}

// ── Step 5: Demonstrate token refresh ───────────────────────────────
// Spec §12.3: Refresh token rotation — old refresh token invalidated,
// new refresh token + new grant token returned.

async function refreshGrant(refreshToken) {
  hr("Step 5 — Refresh the grant token (token rotation)");

  const url = `${GATEWAY}/api/entitlement/refresh`;

  console.log(`  POST ${url}`);
  console.log(`  refresh_token: ${refreshToken.substring(0, 20)}...\n`);

  const result = await fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  console.log(`  New token ID:       ${result.token_id}`);
  console.log(`  Expires in:         ${result.expires_in}s`);
  console.log(`  New grant token:    ${result.grant_token.substring(0, 40)}...`);
  console.log(`  New refresh token:  ${result.refresh_token.substring(0, 20)}...`);
  console.log(`  (Old refresh token is now invalidated — rotation per spec §12.3)`);

  return result;
}

// ── Step 6: Demonstrate token revocation ────────────────────────────
// Spec §12.2: Revocation by jti with reason.

async function revokeGrant(grantToken) {
  hr("Step 6 — Revoke the grant token");

  const url = `${GATEWAY}/api/entitlement/revoke`;

  console.log(`  POST ${url}\n`);

  const result = await fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: grantToken, reason: "demo_complete" }),
  });

  console.log(`  Revoked: ${result.revoked}`);
  console.log(`  JTI:     ${result.jti}`);

  return result;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("\n  OPE Reader Demo (spec v0.1)");
  console.log(`  Publisher: ${PUBLISHER}`);
  console.log(`  Gateway:   ${GATEWAY}`);
  console.log(`  User:      ${USER_ID}`);

  try {
    // 1. Discover
    const discovery = await discoverPublisher();

    // 2. Fetch feed
    const feed = await fetchFeed();

    // 3. Pick a gated item
    const gatedItems = feed.items.filter((i) => i.extensions?.ope);
    if (gatedItems.length === 0) {
      console.log("\n  No gated items found in feed. Nothing more to demo.\n");
      return;
    }

    const targetId = CONTENT_ID || gatedItems[0].extensions.ope.content_id;
    console.log(`  Target content: ${targetId}`);

    // 4. Acquire grant
    const grant = await acquireGrant("subscription");

    // 5. Fetch gated content
    await fetchGatedContent(discovery, targetId, grant.grant_token);

    // 6. Refresh (uses refresh_token, not grant_token — spec §12.3)
    const refreshed = await refreshGrant(grant.refresh_token);

    // 7. Revoke
    await revokeGrant(refreshed.grant_token);

    hr("Done");
    console.log("  The full OPE lifecycle — discover, subscribe, read, refresh, revoke —");
    console.log("  completed successfully.");
    console.log("  Spec: https://feedspec.org/ope (v0.1)\n");
  } catch (err) {
    console.error(`\n  Error: ${err.message}\n`);
    console.error("  Make sure both the publisher (ope-blog) and gateway (ope-gateway)");
    console.error("  are running. See the README for setup instructions.\n");
    process.exit(1);
  }
}

main();
