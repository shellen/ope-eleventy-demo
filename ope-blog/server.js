// ABOUTME: Express server for the OPE publisher, serving static Eleventy output
// ABOUTME: and the JWT-gated content API for local development.

import express from "express";
import jwt from "jsonwebtoken";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const SECRET = process.env.OPE_JWT_SECRET || "dev-secret-change-me";
const SITE_URL = process.env.URL || "https://ope-demo.netlify.app";
const DISCOVERY_URL = `${SITE_URL}/.well-known/ope`;

// Load the content store built by Eleventy
let contentStore = {};
try {
  const storePath = join(__dirname, "_site/api/content/_store.json");
  contentStore = JSON.parse(readFileSync(storePath, "utf-8"));
} catch {
  console.warn("  [publisher] Warning: could not load _store.json — run eleventy build first");
}

function verifyGrant(token) {
  try {
    return jwt.verify(token, SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

function errorJSON(res, status, error, errorDescription, extra = {}) {
  const body = { error, error_description: errorDescription, ...extra };
  body.ope_discovery = DISCOVERY_URL;
  return res.status(status).json(body);
}

const app = express();

// Gated content API — must be registered before the static middleware
app.get("/api/content/:id", (req, res) => {
  const contentId = req.params.id;

  if (contentId === "_store.json") {
    return errorJSON(res, 400, "invalid_request", "Missing content ID");
  }

  // Validate grant token
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return errorJSON(res, 401, "invalid_token",
      "Missing or invalid Authorization header", { content_id: contentId });
  }

  const grant = verifyGrant(match[1]);

  if (!grant) {
    return errorJSON(res, 401, "invalid_token",
      "Invalid or expired grant token", { content_id: contentId });
  }

  if (!grant.scope || !grant.scope.includes("content:read")) {
    return errorJSON(res, 403, "not_entitled",
      "Insufficient scope — content:read required", { content_id: contentId });
  }

  // Per-item grants: check content_ids (spec §8.3)
  if (grant.grant_type === "per_item" && grant.content_ids) {
    if (!grant.content_ids.includes(contentId)) {
      return errorJSON(res, 403, "not_entitled",
        "Per-item grant does not include this content", { content_id: contentId });
    }
  }

  const content = contentStore[contentId];

  if (!content) {
    return errorJSON(res, 404, "not_found",
      "Content not found", { content_id: contentId });
  }

  if (!content.resource_type) {
    content.resource_type = "article";
  }

  res.json(content);
});

// Static files from the Eleventy build
app.use(express.static(join(__dirname, "_site"), { dotfiles: "allow" }));

const server = app.listen(PORT, () => {
  console.log(`\n  OPE Publisher running on http://localhost:${PORT}`);
  console.log(`  Discovery:  http://localhost:${PORT}/.well-known/ope/`);
  console.log(`  Feed:       http://localhost:${PORT}/feed.json`);
  console.log(`  Secret:     ${SECRET === "dev-secret-change-me" ? "(using default dev secret)" : "(custom secret set)"}\n`);
});

export { server };
