import jwt from "jsonwebtoken";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SECRET = process.env.OPE_JWT_SECRET;

let contentStore = null;

function loadStore() {
  if (contentStore) return contentStore;
  try {
    // In Netlify functions, __dirname points to the function directory
    // The content store is bundled via netlify.toml included_files
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const paths = [
      join(__dirname, "../_site/api/content/_store.json"),
      join(__dirname, "../../_site/api/content/_store.json"),
      join(__dirname, "_site/api/content/_store.json"),
    ];
    for (const p of paths) {
      try {
        contentStore = JSON.parse(readFileSync(p, "utf-8"));
        return contentStore;
      } catch { /* try next */ }
    }
    return {};
  } catch {
    return {};
  }
}

function verifyGrant(token) {
  try {
    return jwt.verify(token, SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

export async function handler(event) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "private, max-age=3600",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Extract content ID from path
  const segments = event.path.replace(/^\/+|\/+$/g, "").split("/");
  const contentId = segments[segments.length - 1];

  if (!contentId || contentId === "_store.json") {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing content ID" }) };
  }

  // Validate grant token
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Missing or invalid Authorization header" }) };
  }

  const grant = verifyGrant(match[1]);

  if (!grant) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid or expired grant token" }) };
  }

  if (!grant.scope || !grant.scope.includes("content:read")) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "Insufficient scope" }) };
  }

  // Per-item grants: check content_ids
  if (grant.grant_type === "per_item" && grant.content_ids) {
    if (!grant.content_ids.includes(contentId)) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ status: "not_entitled", reason: "per_item_required" }),
      };
    }
  }

  // Look up content
  const store = loadStore();
  const content = store[contentId];

  if (!content) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: "Content not found", id: contentId }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify(content) };
}
