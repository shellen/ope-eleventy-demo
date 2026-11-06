#!/usr/bin/env node

// ─────────────────────────────────────────────────────────────
// OPE Reader: command-line demo (spec v0.2)
//
// Walks spec Appendix B from an app's point of view:
//   1. Read the feed: which posts are gated, and what's on offer
//   2. Ask for a gated post with no token: 402, and a pointer to its metadata
//   3. Register with the License Server (Dynamic Client Registration)
//   4. Send the person to sign in and choose an Offer (Auth Code + PKCE)
//   5. Exchange the code for a DPoP-bound License Token
//   6. Read the post at its own URL
//   7. Show what a stolen token is worth without its key
//   8. Refresh (rotation), then revoke
//
// Usage:
//   node reader.js                         # opens the sign-in page in your browser
//   node reader.js --auto alice            # fills in the demo forms for "alice"
//   node reader.js --auto alice --offer annual
//   node reader.js --post 004-building-for-readers --offer item-building-for-readers --auto alice
//   node reader.js --no-dpop               # an unbound token (License scheme)
//   node reader.js --keep                  # don't revoke at the end
//
// No dependencies beyond ./ope-client.js (fetch + WebCrypto, Node 20+).
// Spec: https://feedspec.org/ope/spec/0.2/
// ─────────────────────────────────────────────────────────────

import http from "node:http";
import { exec } from "node:child_process";
import { createClient, generateDpopKey, pkce, decodeJwt } from "./ope-client.js";
import { autoAuthorize } from "./auto-consent.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const PUBLISHER = flag("publisher", "http://localhost:8080");
const AUTO = flag("auto", null);
const OFFER = flag("offer", "monthly");
const POST = flag("post", null);
const USE_DPOP = !has("no-dpop");

const client = createClient();

function hr(label) {
  console.log(`\n${"─".repeat(64)}\n  ${label}\n${"─".repeat(64)}\n`);
}
const show = (obj) => console.log(JSON.stringify(obj, null, 2).replace(/^/gm, "  "));
const shorten = (jwt) => jwt.slice(0, 24) + "…" + jwt.slice(-8);

// A loopback redirect (RFC 8252): a one-shot local server receives the code.
function loopbackRedirect() {
  return new Promise((resolve) => {
    let deliver;
    const result = new Promise((r) => { deliver = r; });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "text/html" })
        .end("<p style='font-family:system-ui'>Done. You can close this tab and return to the terminal.</p>");
      server.close();
      deliver(Object.fromEntries(u.searchParams));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ uri: `http://127.0.0.1:${server.address().port}/callback`, result, close: () => server.close() });
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start \"\"" : "xdg-open";
  exec(`${cmd} "${url}"`, () => {});
}

async function main() {
  console.log(`\n  OPE Reader (v0.2)\n  Publisher: ${PUBLISHER}`);

  // ── 1. The feed (Feeds profile) ──
  hr("1. Read the feed");
  const feed = await (await fetch(`${PUBLISHER}/feed.json`)).json();
  console.log(`  ${feed.title}`);
  if (feed._ope) {
    console.log(`  Scope: ${feed._ope.resource}`);
    for (const o of feed._ope.offers || []) console.log(`  Offer: ${o.id}: ${o.name} ($${o.payment.amount} ${o.payment.currency})`);
  }
  console.log();
  for (const item of feed.items) {
    const gated = Boolean(item._ope);
    console.log(`  ${gated ? "[gated]" : "[free] "} ${item.title}`);
  }
  const gatedItems = feed.items.filter((i) => i._ope);
  const target = POST ? gatedItems.find((i) => i.url.includes(POST)) : gatedItems.find((i) => !i._ope.offers) || gatedItems[0];
  if (!target) throw new Error(POST ? `no gated post matching "${POST}"` : "this feed has no gated posts");
  console.log(`\n  Reading: ${target.title}`);

  // ── 2. Discovery (spec §7) ──
  hr("2. Ask for the post with no token");
  const found = await client.discover(target.url);
  console.log(`  ${found.status} from ${found.asset}`);
  for (const c of found.challenges || []) console.log(`  WWW-Authenticate: ${c.scheme} ${Object.entries(c.params).map(([k, v]) => `${k}="${v}"`).join(", ")}`);
  if (found.free) { console.log("  This post is free. Nothing to do."); return; }
  console.log(`\n  Resource metadata for ${found.resourceMetadata.resource}:`);
  console.log(`    License Server: ${found.resourceMetadata.authorization_servers.join(", ")}`);
  for (const o of found.resourceMetadata.ope.offers) console.log(`    Offer: ${o.id} (${o.payment.type}, $${o.payment.amount})`);
  const as = found.authServer;
  console.log(`\n  License Server ${as.issuer} issues for: ${as.protected_resources.join(", ")}`);

  // ── 3. Registration (spec §8.2) ──
  hr("3. Register this app");
  const redirect = AUTO ? { uri: "http://127.0.0.1:9/callback", close() {} } : await loopbackRedirect();
  const app = await client.register(as, { clientName: "OPE CLI Reader", redirectUri: redirect.uri });
  console.log(`  client_id: ${app.client_id} (a public client: no secret)`);
  const key = USE_DPOP ? await generateDpopKey() : null;
  if (key) console.log(`  DPoP key thumbprint: ${key.jkt}`);

  // ── 4. Authorization (spec §8.1) ──
  hr("4. Sign in and choose");
  const { verifier, challenge } = await pkce();
  const state = crypto.randomUUID();
  const resource = found.asset;
  const url = client.authorizationUrl(as, { clientId: app.client_id, redirectUri: redirect.uri, resource, codeChallenge: challenge, state });
  console.log(`  resource=${resource}`);
  let back;
  if (AUTO) {
    console.log(`  --auto: signing in as "${AUTO}" and choosing offer "${OFFER}" (demo checkout)`);
    back = await autoAuthorize(url, { account: AUTO, choose: `offer:${OFFER}` });
  } else {
    console.log(`  Open this URL to sign in (opening your browser):\n\n  ${url}\n`);
    openBrowser(url);
    back = await redirect.result;
  }
  if (back.error) throw new Error(`authorization failed: ${back.error} ${back.error_description || ""}`);
  if (back.state !== state) throw new Error("state mismatch");
  if (back.iss !== as.issuer) throw new Error("iss mismatch (RFC 9207)");
  console.log(`  Got an authorization code from ${back.iss}`);

  // ── 5. Token (spec §8.5, §9) ──
  hr("5. Exchange the code for a License Token");
  let tokens = await client.exchangeCode(as, { clientId: app.client_id, code: back.code, redirectUri: redirect.uri, codeVerifier: verifier, resource }, key);
  console.log(`  token_type: ${tokens.token_type}   expires_in: ${tokens.expires_in}s`);
  console.log(`  covers:     ${tokens.resource}`);
  const claims = decodeJwt(tokens.access_token);
  show({ iss: claims.iss, sub: claims.sub, aud: claims.aud, resource: claims.resource, entitlement: claims.entitlement, cnf: claims.cnf, terms: claims.terms });

  // ── 6. Read (spec §11) ──
  hr("6. Read the post");
  const read = await client.fetchAsset(target.url, tokens, key);
  console.log(`  ${read.status} ${read.ok ? "OK" : ""}`);
  if (read.ok) {
    const html = read.body.content_html;
    const article = (html.match(/<article[\s\S]*?<\/article>/) || [html])[0];
    const text = article.replace(/<(style|script)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    console.log(`  ${read.body.title}\n  ${text.slice(0, 300)}…`);
  } else {
    console.log(`  ${JSON.stringify(read.challenges)}`);
  }

  // ── 7. A stolen token (spec §14) ──
  if (key) {
    hr("7. What a copied token is worth without its key");
    const thief = await generateDpopKey();
    const stolen = await client.fetchAsset(target.url, tokens, thief);
    console.log(`  With another key's proof:   ${stolen.status} (${stolen.challenges[0]?.params.error_description})`);
    const unbound = await client.fetchAsset(target.url, { ...tokens, token_type: "License" }, null);
    console.log(`  As a License-scheme token:  ${unbound.status} (${unbound.challenges[0]?.params.error_description})`);
  }

  // ── 8. Refresh and revoke (spec §12) ──
  hr("8. Refresh, then revoke");
  const old = tokens.refresh_token;
  tokens = await client.refresh(as, { clientId: app.client_id, refreshToken: old }, key);
  console.log(`  Refreshed. New access token ${shorten(tokens.access_token)}; the old refresh token is now spent.`);
  if (has("keep")) {
    console.log("  --keep: leaving this authorization in place. Manage it at " + as.issuer + "/account");
  } else {
    await client.revoke(as, { clientId: app.client_id, token: tokens.refresh_token });
    const after = await client.fetchAsset(target.url, tokens, key);
    console.log(`  Revoked. The publisher now answers ${after.status} (${after.challenges[0]?.params.error_description}).`);
  }
  redirect.close();
  console.log();
}

main().catch((err) => {
  console.error(`\n  Error: ${err.message}\n`);
  if (/fetch failed/.test(err.message)) console.error("  Is everything running? Try ./run-demo.sh\n");
  process.exit(1);
});
