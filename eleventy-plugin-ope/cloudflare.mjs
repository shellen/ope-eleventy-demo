// ABOUTME: A Cloudflare Worker serving an Eleventy site: gated posts through the OPE checks,
// ABOUTME: everything else from the site's static assets. Settings come from the build's content file.

import { createHandler } from "./serve.mjs";

// content: the build's .ope/content.json, imported by the Worker so it's bundled.
// It carries the site's public OPE settings, so the Worker needs no variables;
// set OPE_RS_CLIENT_SECRET as a secret to turn on introspection.
export function cloudflareHandler(content, options = {}) {
  let handle;
  return {
    async fetch(request, env) {
      // Created on the first request: Workers only expose secrets inside a request.
      handle ||= createHandler(options.config || content.config, { ...options, content }).handle;

      // The path as requested, before any parsing: normalization happens in handle().
      const path = request.url.replace(/^[a-z]+:\/\/[^/]+/i, "") || "/";
      const out = await handle({ method: request.method, path, headers: Object.fromEntries(request.headers) });

      if (!out) {
        const response = await env.ASSETS.fetch(request);
        if (!new URL(request.url).pathname.startsWith("/.well-known/")) return response;
        // OAuth metadata: JSON, readable from any origin.
        const headers = new Headers(response.headers);
        headers.set("Content-Type", "application/json");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(response.body, { status: response.status, headers });
      }

      const headers = new Headers({ "Content-Type": out.type });
      for (const [name, value] of Object.entries(out.headers)) {
        for (const v of [].concat(value)) headers.append(name, v); // one challenge per scheme
      }
      return new Response(request.method === "HEAD" ? null : out.body, { status: out.status, headers });
    },
  };
}
