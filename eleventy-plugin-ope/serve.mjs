// ABOUTME: Serves gated posts: normalizes the path, runs the spec §11.2 checks, and picks the response.
// ABOUTME: Framework-independent; express.mjs and netlify.mjs are thin adapters over handle().

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createGate } from "./gate.mjs";

export const DEFAULT_CONTENT_FILE = ".ope/content.json";

// The content file the plugin writes at build time: full posts and their previews,
// kept out of the published site so no static path can ever serve a full post.
export function loadContent(file = process.env.OPE_CONTENT_FILE || DEFAULT_CONTENT_FILE) {
  return JSON.parse(readFileSync(resolve(file), "utf-8"));
}

// Percent-encoded unreserved characters (RFC 3986 §2.3), decoded during normalization.
const UNRESERVED = /%(4[1-9A-F]|5[0-9A]|6[1-9A-F]|7[0-9A]|3[0-9]|2D|2E|5F|7E)/gi;

// Normalize a request path before matching (spec §5.3). Returns null for an
// encoded path separator, which spec §5.3 says to refuse.
export function normalizePath(rawPath) {
  if (/%2f|%5c/i.test(rawPath)) return null;
  const decoded = rawPath.replace(UNRESERVED, (m) => String.fromCharCode(parseInt(m.slice(1), 16)));
  return new URL(decoded, "http://normalize.invalid").pathname;
}

// options: content (from loadContent), introspection { clientId, clientSecret },
// toleranceSeconds. Each defaults from the environment so a site needs no code.
export function createHandler(config, options = {}) {
  const content = options.content || loadContent(options.contentFile);
  const secret = process.env.OPE_RS_CLIENT_SECRET;
  const introspection = options.introspection !== undefined
    ? options.introspection
    : secret ? { clientId: process.env.OPE_RS_CLIENT_ID || "ope-demo-blog", clientSecret: secret } : null;
  const gate = createGate(config, {
    introspection,
    toleranceSeconds: options.toleranceSeconds ?? Number(process.env.OPE_TOLERANCE_SECONDS || 300),
  });

  // request: { method, path (raw, as sent, with any query), headers (lower-case names) }
  // Returns null when the path isn't gated, so the host serves it normally.
  async function handle({ method, path, headers }) {
    const [rawPath, query = ""] = path.split(/\?(.*)/s);
    const normalized = normalizePath(rawPath);
    if (normalized === null) return { status: 400, headers: {}, type: "text/plain", body: "Bad Request" };
    const post = content.posts[normalized] || content.posts[normalized + "/"];
    if (!post || (method !== "GET" && method !== "HEAD")) return null;

    const result = await gate.check({
      method,
      url: config.siteUrl + normalized + (query ? "?" + query : ""),
      headers,
      resourceMetadata: post.metadata && config.siteUrl + post.metadata,
    });
    const responseHeaders = {
      ...result.headers,
      "Cache-Control": "private, no-store",
      "Access-Control-Expose-Headers": "WWW-Authenticate, Entitlement-Remaining",
    };

    if (!result.ok) {
      // People see the preview with a subscribe prompt; apps read the challenge.
      if ([401, 402, 403].includes(result.status)) {
        return { status: result.status, headers: responseHeaders, type: "text/html", body: post.preview };
      }
      return {
        status: result.status, headers: responseHeaders, type: "application/json",
        body: JSON.stringify({ error: result.error, error_description: result.description }),
      };
    }
    if ((headers.accept || "").includes("application/json")) {
      return {
        status: 200, headers: responseHeaders, type: "application/json",
        body: JSON.stringify({ url: result.asset, title: post.title, content_html: post.full, subject: result.claims.sub }),
      };
    }
    return { status: 200, headers: responseHeaders, type: "text/html", body: post.full };
  }

  return { handle, content };
}
