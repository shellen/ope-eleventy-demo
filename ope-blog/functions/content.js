import jwt from "jsonwebtoken";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SECRET = process.env.OPE_JWT_SECRET;
const DISCOVERY_URL = process.env.OPE_SITE_URL
  ? `${process.env.OPE_SITE_URL}/.well-known/ope`
  : undefined;

let contentStore = null;

function loadStore() {
  if (contentStore) return contentStore;
  try {
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

// Spec §10.3: structured error responses
function errorJSON(error, errorDescription, extra = {}) {
  const body = { error, error_description: errorDescription, ...extra };
  if (DISCOVERY_URL) body.ope_discovery = DISCOVERY_URL;
  return JSON.stringify(body);
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
    return { statusCode: 405, headers, body: errorJSON("invalid_request", "Method not allowed") };
  }

  // Extract content ID from path
  const segments = event.path.replace(/^\/+|\/+$/g, "").split("/");
  const contentId = segments[segments.length - 1];

  if (!contentId || contentId === "_store.json") {
    return { statusCode: 400, headers, body: errorJSON("invalid_request", "Missing content ID") };
  }

  // Validate grant token
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return {
      statusCode: 401,
      headers,
      body: errorJSON("invalid_token", "Missing or invalid Authorization header", { content_id: contentId }),
    };
  }

  const grant = verifyGrant(match[1]);

  if (!grant) {
    return {
      statusCode: 401,
      headers,
      body: errorJSON("invalid_token", "Invalid or expired grant token", { content_id: contentId }),
    };
  }

  if (!grant.scope || !grant.scope.includes("content:read")) {
    return {
      statusCode: 403,
      headers,
      body: errorJSON("not_entitled", "Insufficient scope — content:read required", { content_id: contentId }),
    };
  }

  // Per-item grants: check content_ids (spec §8.3)
  if (grant.grant_type === "per_item" && grant.content_ids) {
    if (!grant.content_ids.includes(contentId)) {
      return {
        statusCode: 403,
        headers,
        body: errorJSON("not_entitled", "Per-item grant does not include this content", { content_id: contentId }),
      };
    }
  }

  // Look up content
  const store = loadStore();
  const content = store[contentId];

  if (!content) {
    return {
      statusCode: 404,
      headers,
      body: errorJSON("not_found", "Content not found", { content_id: contentId }),
    };
  }

  // Spec §10.1: include resource_type in response
  if (!content.resource_type) {
    content.resource_type = "article";
  }

  return { statusCode: 200, headers, body: JSON.stringify(content) };
}
