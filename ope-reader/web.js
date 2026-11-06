// ─────────────────────────────────────────────────────────────
// OPE Reader: web UI server (spec v0.2)
//
// Serves the browser reader (index.html + ope-client.js) and one narrow proxy
// to the publisher. The browser talks to the License Server directly: its public
// endpoints allow any origin. The publisher's gated posts don't answer CORS
// preflights, so their requests go through /proxy, which forwards the headers
// OPE needs (Authorization, DPoP, Accept) and returns the ones it sends back.
// The DPoP proof still names the publisher's URL, not the proxy's.
//
// Usage:
//   node web.js
//   node web.js --publisher http://localhost:8080 --port 3000
// ─────────────────────────────────────────────────────────────

import express from "express";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PUBLISHER = new URL(flag("publisher", "http://localhost:8080")).origin;
const PORT = parseInt(flag("port", "3000"), 10);

const app = express();

app.get("/", (_req, res) => res.sendFile(join(__dirname, "index.html")));
app.get("/ope-client.js", (_req, res) => res.type("text/javascript").sendFile(join(__dirname, "ope-client.js")));
app.get("/config.json", (_req, res) => res.json({ publisher: PUBLISHER }));

// The OAuth redirect lands here, in the sign-in popup: hand the result to the
// page that opened it, on this origin only, and close.
app.get("/callback", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Signed in</title>
<p style="font-family:system-ui">Returning to the reader…</p>
<script>
  const params = Object.fromEntries(new URLSearchParams(location.search));
  if (window.opener) { window.opener.postMessage({ ope: "callback", params }, location.origin); window.close(); }
</script>`);
});

// Proxy to the publisher only: never an open proxy.
app.get("/proxy", async (req, res) => {
  let target;
  try { target = new URL(String(req.query.url)); } catch { return res.status(400).send("bad url"); }
  if (target.origin !== PUBLISHER) return res.status(403).send("this proxy only reaches the demo publisher");

  const headers = {};
  for (const h of ["accept", "authorization", "dpop"]) if (req.headers[h]) headers[h] = req.headers[h];
  try {
    const r = await fetch(target, { headers, redirect: "follow" });
    for (const h of ["content-type", "www-authenticate", "entitlement-remaining"]) {
      const v = r.headers.get(h);
      if (v) res.set(h, v);
    }
    res.status(r.status).send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    res.status(502).json({ error: "publisher_unreachable", error_description: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  OPE Reader (web) running on http://localhost:${PORT}`);
  console.log(`  Publisher: ${PUBLISHER}\n`);
});
