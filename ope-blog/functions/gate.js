// ABOUTME: Netlify function serving gated posts for the OPE v0.2 publisher.
// ABOUTME: Runs the same spec §11.2 checks as server.js, via lib/ope-gate.js.

import { readFileSync } from "fs";
import { join } from "path";
import opeConfig from "../ope.config.js";
import { createGate } from "../lib/ope-gate.js";

const SITE = join(process.cwd(), "_site");

const gate = createGate(opeConfig, {
  introspection: process.env.OPE_RS_CLIENT_SECRET
    ? { clientId: process.env.OPE_RS_CLIENT_ID || "ope-demo-blog", clientSecret: process.env.OPE_RS_CLIENT_SECRET }
    : null,
  toleranceSeconds: Number(process.env.OPE_TOLERANCE_SECONDS || 300),
});

let gated;
function gatedIndex() {
  gated ||= JSON.parse(readFileSync(join(SITE, "_ope/gated.json"), "utf-8"));
  return gated;
}

export async function handler(event) {
  const url = new URL(event.rawUrl);
  const entry = gatedIndex()[url.pathname];
  if (!entry) return { statusCode: 404, body: "Not found" };

  const headers = Object.fromEntries(Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const result = await gate.check({ method: event.httpMethod, url: opeConfig.siteUrl + url.pathname + url.search, headers });

  const multiValueHeaders = Object.fromEntries(
    Object.entries(result.headers).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
  const common = {
    "Cache-Control": "private, no-store",
    "Access-Control-Expose-Headers": "WWW-Authenticate, Entitlement-Remaining",
  };

  if (!result.ok) {
    const preview = [401, 402, 403].includes(result.status);
    return {
      statusCode: result.status,
      headers: { ...common, "Content-Type": preview ? "text/html" : "application/json" },
      multiValueHeaders,
      body: preview
        ? readFileSync(join(SITE, entry.preview), "utf-8")
        : JSON.stringify({ error: result.error, error_description: result.description }),
    };
  }

  const html = readFileSync(join(SITE, entry.full), "utf-8");
  const wantsJson = (headers.accept || "").includes("application/json");
  return {
    statusCode: 200,
    headers: { ...common, "Content-Type": wantsJson ? "application/json" : "text/html" },
    multiValueHeaders,
    body: wantsJson ? JSON.stringify({ url: result.asset, title: entry.title, content_html: html }) : html,
  };
}
