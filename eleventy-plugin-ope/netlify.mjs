// ABOUTME: A Netlify Function serving gated posts through the OPE checks.
// ABOUTME: The plugin's _redirects send each gated post's URL here; everything else stays static.

import { createHandler } from "./serve.mjs";

// content: the build's content file, imported by the function so it is bundled
// with it (no runtime file paths to get wrong).
export function netlifyHandler(config, content, options = {}) {
  const { handle } = createHandler(config, { ...options, content });
  return async (event) => {
    // The URL as requested, not the function's own path. Keep it raw: normalization
    // happens in handle(), and URL parsing here would hide encoded separators.
    const path = event.rawUrl.replace(/^[a-z]+:\/\/[^/]+/i, "") || "/";
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const out = await handle({ method: event.httpMethod, path, headers });
    if (!out) return { statusCode: 404, body: "Not found" };

    // WWW-Authenticate carries one challenge per scheme: send them as separate fields.
    const single = {};
    const multi = {};
    for (const [name, value] of Object.entries(out.headers)) {
      if (Array.isArray(value)) multi[name] = value;
      else single[name] = value;
    }
    return {
      statusCode: out.status,
      headers: { ...single, "Content-Type": out.type },
      multiValueHeaders: multi,
      body: out.body,
    };
  };
}
