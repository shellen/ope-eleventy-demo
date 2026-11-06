// ABOUTME: Express server for the OPE v0.2 publisher: the static Eleventy site, with gated posts
// ABOUTME: served at their own URLs only after the spec §11.2 checks in lib/ope-gate.js pass.

import express from "express";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import opeConfig from "./ope.config.js";
import { createGate } from "./lib/ope-gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// OPE_SITE_DIR lets tests serve a build made for other ports.
const SITE = process.env.OPE_SITE_DIR || join(__dirname, "_site");
const PORT = process.env.PORT || 8080;

// The publisher's introspection credential at the License Server, issued out of band
// (spec §13.4). run-demo.sh generates one per session and gives it to both servers.
const introspection = process.env.OPE_RS_CLIENT_SECRET
  ? { clientId: process.env.OPE_RS_CLIENT_ID || "ope-demo-blog", clientSecret: process.env.OPE_RS_CLIENT_SECRET }
  : null;

const gate = createGate(opeConfig, {
  introspection,
  toleranceSeconds: Number(process.env.OPE_TOLERANCE_SECONDS || 300),
});

// Which posts are gated, from the plugin's build output.
let gated = {};
try {
  gated = JSON.parse(readFileSync(join(SITE, "_ope/gated.json"), "utf-8"));
} catch {
  console.warn("  [publisher] Warning: no _site/_ope/gated.json; run the Eleventy build first");
}

const app = express();

// Normalize every request path before routing (spec §5.3): refuse encoded path
// separators, decode percent-encoded unreserved characters, and resolve dot-segments.
// Without this, "/posts/x/../../_ope/full/..." or "/%5Fope/full/..." would reach the
// static files and serve a full gated post with no token.
const UNRESERVED = /%(4[1-9A-F]|5[0-9A]|6[1-9A-F]|7[0-9A]|3[0-9]|2D|2E|5F|7E)/gi;
app.use((req, res, next) => {
  const [rawPath, ...rest] = req.url.split("?");
  if (/%2f|%5c/i.test(rawPath)) return res.status(400).send("Bad Request");
  const decoded = rawPath.replace(UNRESERVED, (m) => String.fromCharCode(parseInt(m.slice(1), 16)));
  const normalized = new URL(decoded, "http://normalize.invalid").pathname;
  req.url = normalized + (rest.length ? "?" + rest.join("?") : "");
  next();
});

// Full versions of gated posts are never served directly.
app.use((req, res, next) => (req.path.startsWith("/_ope/") ? res.sendStatus(404) : next()));

// Gated posts: run the checks, then send the full post (or JSON for apps that ask).
app.use(async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const path = req.path;
  const entry = gated[path] || gated[path + "/"];
  if (!entry) return next();

  const result = await gate.check({
    method: req.method,
    url: opeConfig.siteUrl + req.url,
    headers: req.headers,
  });
  for (const [name, value] of Object.entries(result.headers)) res.append(name, value);
  res.set("Access-Control-Expose-Headers", "WWW-Authenticate, Entitlement-Remaining");
  res.set("Cache-Control", "private, no-store");

  if (!result.ok) {
    // People see the preview with a subscribe prompt; apps read the challenge.
    res.status(result.status);
    if (result.status === 402 || result.status === 401 || result.status === 403) {
      return res.type("html").send(readFileSync(join(SITE, entry.preview), "utf-8"));
    }
    return res.json({ error: result.error, error_description: result.description });
  }

  const html = readFileSync(join(SITE, entry.full), "utf-8");
  if ((req.headers.accept || "").includes("application/json")) {
    return res.json({ url: result.asset, title: entry.title, content_html: html, subject: result.claims.sub });
  }
  res.type("html").send(html);
});

// OAuth metadata: JSON, readable from any origin (Web profile, CORS).
app.use("/.well-known", (_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  next();
});

app.use(express.static(SITE, {
  dotfiles: "allow",
  setHeaders(res, filePath) {
    if (filePath.includes(`${join("_site", ".well-known")}`)) res.type("application/json");
  },
}));

const server = app.listen(PORT, () => {
  console.log(`\n  OPE Publisher running on ${opeConfig.siteUrl}`);
  console.log(`  Scope metadata: ${opeConfig.siteUrl}/.well-known/oauth-protected-resource/posts/`);
  console.log(`  Feed:           ${opeConfig.siteUrl}/feed.json`);
  console.log(`  License Server: ${opeConfig.licenseServers.join(", ")}`);
  console.log(`  Revocation:     ${introspection ? "introspection on (tolerance " + (process.env.OPE_TOLERANCE_SECONDS || 300) + "s)" : "expiry only (no introspection credential)"}\n`);
});

export { server, app };
