#!/usr/bin/env node

// ─────────────────────────────────────────────────────────────
// OPE Reader — minimal demo
//
// Shows the full OPE flow from a reader's perspective:
//   1. Discover publisher capabilities via /.well-known/ope
//   2. Fetch the JSON Feed and list items (free vs. gated)
//   3. Acquire a grant token from the gateway
//   4. Use the grant to fetch full gated content from the publisher
//
// Usage:
//   node reader.js                          # use defaults
//   node reader.js --publisher http://localhost:8080
//   node reader.js --gateway http://localhost:4000
//   node reader.js --user alice --content protocol-economics
//
// No dependencies — uses only built-in Node.js fetch API (Node 18+)
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

// ── Step 1: Discover publisher OPE config ───────────────────────────

async function discoverPublisher() {
  hr("Step 1 — Discover publisher via /.well-known/ope");

  const url = `${PUBLISHER}/.well-known/ope`;
  console.log(`  GET ${url}\n`);

  const discovery = await fetchJSON(url);

  console.log(`  Publisher OPE config:`);
  console.log(`    Version:          ${discovery.version}`);
  console.log(`    Content endpoint: ${discovery.content?.endpoint_template}`);
  console.log(`    Token format:     ${discovery.entitlement?.token_format}`);
  console.log(`    Default TTL:      ${discovery.entitlement?.default_ttl_seconds}s`);
  console.log(`    Grants supported: ${discovery.grants_supported?.join(", ")}`);

  if (discovery.metadata?.plans?.length) {
    console.log(`    Plans:`);
    for (const plan of discovery.metadata.plans) {
      console.log(`      - ${plan.name}: $${(plan.amount / 100).toFixed(2)} ${plan.currency}`);
    }
  }

  return discovery;
}

// ── Step 2: Fetch the JSON Feed ─────────────────────────────────────

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
      console.log(`           Content ID: ${ope.content_id} | ${ope.content_metadata?.word_count} words | ${ope.content_metadata?.unlock_cta}`);
    }
    console.log();
  }

  return feed;
}

// ── Step 3: Acquire a grant from the gateway ────────────────────────

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

  console.log(`  Status:     ${result.status}`);
  console.log(`  Grant type: ${result.grant_type}`);
  console.log(`  Token ID:   ${result.token_id}`);
  console.log(`  Expires:    ${result.expires_at}`);
  console.log(`  Token:      ${result.token.substring(0, 40)}...`);

  return result;
}

// ── Step 4: Fetch gated content using the grant ─────────────────────

async function fetchGatedContent(discovery, contentId, token) {
  hr("Step 4 — Fetch gated content from the publisher");

  // Build the content URL from the discovery template
  const template = discovery.content?.endpoint_template || `${PUBLISHER}/api/content/{id}`;
  const url = template.replace("{id}", contentId);

  console.log(`  GET ${url}`);
  console.log(`  Authorization: Bearer ${token.substring(0, 30)}...\n`);

  const content = await fetchJSON(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  console.log(`  Content received!`);
  console.log(`  Title:     ${content.title}`);
  console.log(`  Published: ${content.published}`);

  // Show a preview of the HTML content (strip tags)
  const plainText = content.content_html?.replace(/<[^>]+>/g, "") || "";
  const preview = plainText.substring(0, 300);
  console.log(`\n  Preview:\n`);
  console.log(`  ${preview}${plainText.length > 300 ? "..." : ""}`);

  return content;
}

// ── Step 5: Demonstrate token refresh ───────────────────────────────

async function refreshGrant(token) {
  hr("Step 5 — Refresh the grant token");

  const url = `${GATEWAY}/api/entitlement/refresh`;

  console.log(`  POST ${url}\n`);

  const result = await fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

  console.log(`  Status:       ${result.status}`);
  console.log(`  New token ID: ${result.token_id}`);
  console.log(`  New expiry:   ${result.expires_at}`);

  return result;
}

// ── Step 6: Demonstrate token revocation ────────────────────────────

async function revokeGrant(token) {
  hr("Step 6 — Revoke the grant token");

  const url = `${GATEWAY}/api/entitlement/revoke`;

  console.log(`  POST ${url}\n`);

  const result = await fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

  console.log(`  Status:   ${result.status}`);
  console.log(`  Token ID: ${result.token_id}`);

  return result;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("\n  OPE Reader Demo");
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
    await fetchGatedContent(discovery, targetId, grant.token);

    // 6. Refresh
    const refreshed = await refreshGrant(grant.token);

    // 7. Revoke
    await revokeGrant(refreshed.token);

    hr("Done");
    console.log("  The full OPE lifecycle — discover, subscribe, read, refresh, revoke —");
    console.log("  completed successfully.\n");
  } catch (err) {
    console.error(`\n  Error: ${err.message}\n`);
    console.error("  Make sure both the publisher (ope-blog) and gateway (ope-gateway)");
    console.error("  are running. See the README for setup instructions.\n");
    process.exit(1);
  }
}

main();
