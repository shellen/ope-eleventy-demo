// ─────────────────────────────────────────────────────────────
// OPE Reader — Web UI server
//
// A small Express server that:
//   1. Serves the browser-based reader UI (index.html)
//   2. Proxies API calls to the publisher and gateway so the
//      browser doesn't hit CORS issues
//
// Usage:
//   node web.js
//   node web.js --publisher http://localhost:8080 --gateway http://localhost:4000
//
// Then open http://localhost:3000 in your browser.
// ─────────────────────────────────────────────────────────────

import express from "express";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PUBLISHER = flag("publisher", "http://localhost:8080");
const GATEWAY = flag("gateway", "http://localhost:4000");
const PORT = parseInt(flag("port", "3000"), 10);

const app = express();
app.use(express.json());

// Serve the HTML UI
app.get("/", (_req, res) => {
  const html = readFileSync(join(__dirname, "index.html"), "utf-8");
  res.type("html").send(html);
});

// Proxy: publisher discovery
app.get("/proxy/discovery", async (_req, res) => {
  try {
    const r = await fetch(`${PUBLISHER}/.well-known/ope`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "Publisher unreachable", detail: err.message });
  }
});

// Proxy: publisher feed
app.get("/proxy/feed", async (_req, res) => {
  try {
    const r = await fetch(`${PUBLISHER}/feed.json`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "Publisher unreachable", detail: err.message });
  }
});

// Proxy: gateway grant
app.post("/proxy/grant", async (req, res) => {
  try {
    const r = await fetch(`${GATEWAY}/api/entitlement/grant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "Gateway unreachable", detail: err.message });
  }
});

// Proxy: publisher content
app.get("/proxy/content/:id", async (req, res) => {
  try {
    const token = req.headers.authorization;
    const r = await fetch(`${PUBLISHER}/api/content/${req.params.id}`, {
      headers: token ? { Authorization: token } : {},
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "Publisher unreachable", detail: err.message });
  }
});

// Proxy: gateway refresh
app.post("/proxy/refresh", async (req, res) => {
  try {
    const r = await fetch(`${GATEWAY}/api/entitlement/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "Gateway unreachable", detail: err.message });
  }
});

// Proxy: gateway revoke
app.post("/proxy/revoke", async (req, res) => {
  try {
    const r = await fetch(`${GATEWAY}/api/entitlement/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "Gateway unreachable", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  OPE Reader (Web UI) running on http://localhost:${PORT}`);
  console.log(`  Publisher: ${PUBLISHER}`);
  console.log(`  Gateway:   ${GATEWAY}\n`);
});
