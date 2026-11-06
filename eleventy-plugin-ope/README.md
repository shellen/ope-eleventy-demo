# eleventy-plugin-ope

Add [Open Portable Entitlement v0.2](https://feedspec.org/ope/spec/0.2/) to an Eleventy site: subscriber-only posts that readers can unlock in any OPE app, with a License Server of your choosing handling accounts and payment.

The plugin does two jobs:

- **At build time** it publishes what apps read to find out how to get access: OAuth Protected Resource metadata (RFC 9728), your Offers in the feed, and the routing for gated posts.
- **At request time** it serves gated posts: a preview and a `402` without a valid token, the full post with one. It runs as a Netlify Function or as Express middleware.

## Setup: four steps

**1. Install**

```bash
npm install eleventy-plugin-ope       # requires @11ty/eleventy 3.x
```

**2. Describe what you sell** in `ope.config.js`:

```js
const siteUrl = (process.env.OPE_SITE_URL || process.env.URL || "http://localhost:8080").replace(/\/$/, "");

export default {
  siteUrl,
  publisherName: "Your Blog",
  publisher: `${siteUrl}/`,                                  // spec §5.8
  licenseServers: [process.env.OPE_LICENSE_SERVER],          // who may issue access (spec §7.1)
  terms: { url: `${siteUrl}/terms/`, type: "text/html" },    // spec §6.1
  scopes: [
    {
      scope: `${siteUrl}/posts/`,                            // covers every post under it (spec §5.5)
      offers: [
        {
          id: "monthly",
          name: "Your Blog, monthly",
          payment: { type: "subscription", amount: "5.00", currency: "USD", period: "P1M" },
          purchase_url: `${siteUrl}/subscribe/`,
          entitlement_types: ["access"],
        },
      ],
    },
  ],
  fullLayout: "post.njk",             // the layout full posts are rendered with
  netlify: { functionName: "ope" },   // write _redirects for Netlify (leave out elsewhere)
};
```

On Netlify, `URL` is your site's address, so `OPE_SITE_URL` is only needed to override it.

**3. Add the plugin** in `eleventy.config.js`, and mark posts as gated:

```js
import opePlugin from "eleventy-plugin-ope";
import opeConfig from "./ope.config.js";

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(opePlugin, opeConfig);
}
```

```yaml
---
title: A subscriber-only post
ope_gated: true
---
```

In your post layout, show a preview when `ope_gated` is set and `ope_unlocked` isn't. The plugin renders each gated post a second time with `ope_unlocked: true`, which becomes the full version:

```njk
{% if ope_gated and not ope_unlocked %}
  <p>{{ content | opePreview(400) }}</p>
  <a href="/subscribe/">Subscribe to read the rest</a>
{% else %}
  {{ content | safe }}
{% endif %}
```

**4. Serve gated posts.** On Netlify, add `functions/ope.mjs`, with `functions = "functions"` under `[build]` in `netlify.toml`. The imports are relative to the function file:

```js
import { netlifyHandler } from "eleventy-plugin-ope/netlify";
import config from "../ope.config.js";
import content from "../.ope/content.json" with { type: "json" };

export const handler = netlifyHandler(config, content);
```

Then set `OPE_LICENSE_SERVER` in Netlify's environment variables. With Express instead:

```js
import { opeMiddleware } from "eleventy-plugin-ope/express";
app.use(opeMiddleware(config));      // before express.static("_site")
```

That's all a publisher writes. Optionally, set `OPE_RS_CLIENT_SECRET` (and `OPE_RS_CLIENT_ID`) to the introspection credential your License Server gives you. Revocation then takes effect at once instead of when the token expires, within the hour.

## Where full posts live

Full posts are never part of the published site. The plugin renders them during the build, moves them with their previews into `.ope/content.json`, and deletes them from the output folder. That file is bundled into the Netlify Function, or read by the Express middleware. A static host has nothing secret to serve, however a request path is spelled. Add `.ope/` to `.gitignore`.

## Selling a single post too

```yaml
---
ope_gated: true
ope_offers:                   # added to the scope's Offers for this post
  - id: "item-this-post"
    name: "This post only"
    payment: { type: "purchase", amount: "2.00", currency: "USD" }
    purchase_url: "/subscribe/"
    entitlement_types: ["access"]
---
```

The plugin writes per-URL metadata for that post, and its `402` challenge points apps there with `resource_metadata` (spec §7.1).

## What the build writes

| Path | Contents |
|---|---|
| `/.well-known/oauth-protected-resource/<scope path>` | Scope metadata, one document per scope (RFC 9728 §3.1 placement) |
| `/.well-known/oauth-protected-resource/<post path>` | Per-URL metadata, only for posts with `ope_offers` |
| `/_redirects` | With `netlify` set: each gated post's URL → the function |
| `.ope/content.json` | Outside the site: full posts, previews, titles, per-URL metadata paths |

Each metadata document is written as a folder `index.html`, so static hosts serve it at the slashless URL. Serve `/.well-known/*` as `application/json` with `Access-Control-Allow-Origin: *`; see the demo's `netlify.toml`.

## What the request-time code checks

Every request for a gated post, in spec order:

1. **Normalize the path** (spec §5.3). Refuse `%2F` and `%5C` (`400`), decode unreserved characters, and resolve dot-segments.
2. **No token, or a `Bearer` token:** `402`, with a challenge carrying `ope_scope` (or `resource_metadata`), and the preview page as the body.
3. **Check the signature and claims.** ES256 with the License Server's keys, refetched at least every 5 minutes. Also `typ: license+jwt`, an issuer your metadata lists, `aud`, and `exp`.
4. **Check coverage:** the token's `resource` and `coverage` include this post, and `publisher` is you.
5. **Check the Entitlement:** `access` or `limit`, and a rental that hasn't ended.
6. **Check the DPoP proof** for a key-bound token.
7. **Check revocation** with the License Server's `/introspect`, when the token has more than `OPE_TOLERANCE_SECONDS` (default 300) left and you've set a credential.

Then it serves the full post, or JSON (`url`, `title`, `content_html`, `subject`) to apps that ask for `application/json`.

## For templates

- Global data `ope`: your config plus `version: "0.2"`.
- Collections: `opeGated` and `opeItemOffers`.
- Filters: `opeJson`, `opeAbsolute`, `opeItemOffers(post)`, `opePreview(content, chars)`, `opeWordCount`, `opeReadTime`.

## Lower-level exports

```js
import { createHandler, loadContent, normalizePath } from "eleventy-plugin-ope/serve";   // adapt to any host
import { createGate } from "eleventy-plugin-ope/gate";                                   // just the §11.2 checks
const { scopeMetadata, itemMetadata, scopeFor, metadataPath } = require("eleventy-plugin-ope");
```
