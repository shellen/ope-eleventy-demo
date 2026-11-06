// ABOUTME: Local server for the OPE v0.2 publisher: gated posts through the plugin's checks,
// ABOUTME: everything else as static files from the Eleventy build.

import express from "express";
import { opeMiddleware } from "eleventy-plugin-ope/express";
import config from "./ope.config.js";

const PORT = process.env.PORT || 8080;
const SITE = process.env.OPE_SITE_DIR || "_site";

const app = express();
app.use(opeMiddleware(config));

// OAuth metadata: JSON, readable from any origin.
app.use("/.well-known", (_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*").type("application/json");
  next();
});
app.use(express.static(SITE, { dotfiles: "allow" }));

const server = app.listen(PORT, () => {
  console.log(`\n  OPE Publisher running on ${config.siteUrl}`);
  console.log(`  Scope metadata: ${config.siteUrl}/.well-known/oauth-protected-resource/posts/`);
  console.log(`  License Server: ${config.licenseServers.join(", ")}`);
  console.log(`  Revocation:     ${process.env.OPE_RS_CLIENT_SECRET ? "introspection on" : "at expiry only (no introspection credential)"}\n`);
});

export { server, app };
