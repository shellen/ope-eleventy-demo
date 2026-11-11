// ABOUTME: Serves gated posts: normalizes the path, runs the spec §11.2 checks, and picks the response.
// ABOUTME: Framework-independent; express.mjs and netlify.mjs are thin adapters over handle().

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

// ── Web profile (spec Part II, B): unlocking posts on the site itself ──
// The site signs the reader in at its License Server from its own server, as a
// confidential client, and keeps the License Token in an HttpOnly cookie.
const TXN_COOKIE = "ope_txn"; //       the sign-in in progress (PKCE verifier, state, post)
const ACCESS_COOKIE = "ope_access"; // the License Token, unbound (a browser can't send DPoP with a cookie)
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function parseCookies(header = "") {
  return Object.fromEntries(header.split(/;\s*/).filter(Boolean).map((c) => {
    const i = c.indexOf("=");
    return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
  }));
}

function cookie(name, value, { maxAge, path = "/", secure }) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function webProfile(config, options) {
  const clientId = options.site?.clientId || process.env.OPE_RS_CLIENT_ID || "ope-demo-blog";
  const clientSecret = options.site?.clientSecret || process.env.OPE_RS_CLIENT_SECRET;
  if (!clientSecret) return null;
  const issuer = config.licenseServers[0];
  const secure = config.siteUrl.startsWith("https:");
  const callback = `${config.siteUrl}/_ope/callback`;
  let metadata;
  const authServer = async () => (metadata ||= await fetch(`${issuer}/.well-known/oauth-authorization-server`).then((r) => {
    if (!r.ok) throw new Error(`License Server metadata ${r.status}`);
    return r.json();
  }));

  // The sign-in in progress travels in a cookie signed with the client secret.
  const sign = (data) => createHmac("sha256", clientSecret).update(data).digest("base64url");
  const seal = (obj) => { const data = b64url(JSON.stringify(obj)); return `${data}.${sign(data)}`; };
  const open = (sealed) => {
    const [data, mac] = String(sealed || "").split(".");
    if (!data || !mac) return null;
    const want = Buffer.from(sign(data));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    return JSON.parse(Buffer.from(data, "base64url").toString());
  };

  return { clientId, clientSecret, issuer, secure, callback, authServer, seal, open };
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

  let site; // the Web profile's settings, read on first use (Workers expose secrets only in a request)
  const redirect = (location, cookies = []) => ({ status: 303, headers: { Location: location, ...(cookies.length ? { "Set-Cookie": cookies } : {}) }, type: "text/plain", body: "" });
  const page = (status, text) => ({ status, headers: { "Cache-Control": "no-store" }, type: "text/html", body:
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unlock</title><body style="font:16px/1.5 system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem">${text}</body>` });

  // The post a request names: a gated path on this site, as a path.
  function gatedPath(ref) {
    try {
      const u = new URL(ref || "", config.siteUrl + "/");
      if (u.origin !== new URL(config.siteUrl).origin) return null;
      return content.posts[u.pathname] ? u.pathname : null;
    } catch { return null; }
  }

  // GET /_ope/unlock?post=<path>: start signing the reader in at the License Server.
  async function unlock(params) {
    const post = gatedPath(params.get("post"));
    if (!post) return page(404, "<p>That isn't a subscriber-only post on this site.</p>");
    if (!site) return page(501, `<p>This site isn't set up to unlock posts in the browser yet. Read it in an <a href="/reader/?post=${encodeURIComponent(config.siteUrl + post)}">OPE app</a> instead.</p>`);
    const as = await site.authServer();
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const url = new URL(as.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: site.clientId,
      redirect_uri: site.callback,
      resource: config.siteUrl + post, // the Asset (spec §8.1)
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
    }).toString();
    return redirect(url.href, [cookie(TXN_COOKIE, site.seal({ verifier, state, post }), { maxAge: 600, path: "/_ope/", secure: site.secure })]);
  }

  // GET /_ope/callback: exchange the code, check the token, keep it in a cookie.
  async function callback(params, cookies) {
    if (!site) return page(501, "<p>This site isn't set up to unlock posts in the browser.</p>");
    const txn = site.open(cookies[TXN_COOKIE]);
    const clearTxn = cookie(TXN_COOKIE, "", { maxAge: 0, path: "/_ope/", secure: site.secure });
    if (!txn || params.get("state") !== txn.state) return page(400, "<p>This sign-in expired or didn't start here. Go back to the post and try again.</p>");
    if (params.get("iss") !== site.issuer) return page(400, "<p>The sign-in response came from an unexpected server.</p>");
    if (params.get("error")) return redirect(`${txn.post}?unlock=${encodeURIComponent(params.get("error"))}`, [clearTxn]);

    const as = await site.authServer();
    const res = await fetch(as.token_endpoint, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${encodeURIComponent(site.clientId)}:${encodeURIComponent(site.clientSecret)}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: params.get("code") || "",
        redirect_uri: site.callback,
        code_verifier: txn.verifier,
        resource: config.siteUrl + txn.post,
      }),
    });
    const tokens = await res.json().catch(() => ({}));
    if (!res.ok) return redirect(`${txn.post}?unlock=${encodeURIComponent(tokens.error || "token_error")}`, [clearTxn]);

    // Validate it as any request would be (spec §11.2) before trusting it.
    const check = await gate.check({ method: "GET", url: config.siteUrl + txn.post, headers: { authorization: `License ${tokens.access_token}` } });
    if (!check.ok) return redirect(`${txn.post}?unlock=invalid_token`, [clearTxn]);
    const maxAge = Math.max(0, Math.min(Number(tokens.expires_in) || 0, check.claims.exp - Math.floor(Date.now() / 1000)));
    return redirect(txn.post, [clearTxn, cookie(ACCESS_COOKIE, tokens.access_token, { maxAge, secure: site.secure })]);
  }

  // request: { method, path (raw, as sent, with any query), headers (lower-case names) }
  // Returns null when the path isn't gated, so the host serves it normally.
  async function handle({ method, path, headers }) {
    const [rawPath, query = ""] = path.split(/\?(.*)/s);
    const normalized = normalizePath(rawPath);
    if (normalized === null) return { status: 400, headers: {}, type: "text/plain", body: "Bad Request" };
    if (site === undefined) site = webProfile(config, options);
    const cookies = parseCookies(headers.cookie);
    const params = new URLSearchParams(query);
    if (method === "GET" && normalized === "/_ope/unlock") return unlock(params);
    if (method === "GET" && normalized === "/_ope/callback") return callback(params, cookies);
    if (method === "GET" && normalized === "/_ope/leave") {
      const back = gatedPath(params.get("post")) || "/";
      return redirect(back, [cookie(ACCESS_COOKIE, "", { maxAge: 0, secure: site?.secure })]);
    }
    const post = content.posts[normalized] || content.posts[normalized + "/"];
    if (!post || (method !== "GET" && method !== "HEAD")) return null;

    // Checked in the Web profile's order: the Authorization header, then the cookie.
    const fromCookie = !headers.authorization && cookies[ACCESS_COOKIE];
    const result = await gate.check({
      method,
      url: config.siteUrl + normalized + (query ? "?" + query : ""),
      headers: fromCookie ? { ...headers, authorization: `License ${cookies[ACCESS_COOKIE]}` } : headers,
      resourceMetadata: post.metadata && config.siteUrl + post.metadata,
    });
    // An expired or revoked cookie token is dropped; one that just doesn't cover this
    // post (a single-article purchase, say) is kept.
    if (fromCookie && result.status === 401) {
      result.headers["Set-Cookie"] = [cookie(ACCESS_COOKIE, "", { maxAge: 0, secure: site?.secure })];
    }
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
