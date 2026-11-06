# eleventy-plugin-ope

An Eleventy plugin that publishes [Open Portable Entitlement v0.2](https://feedspec.org/ope/spec/0.2/) metadata for your site: what's gated, what's for sale, and which License Servers may issue access to it.

It doesn't check tokens. That happens in your server (see `ope-blog/lib/ope-gate.js` for a complete example). The plugin writes the documents apps read to find out how to get access.

## Install

```bash
npm install eleventy-plugin-ope       # requires @11ty/eleventy 3.x
```

## Configure

```js
// eleventy.config.js
import opePlugin from "eleventy-plugin-ope";

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(opePlugin, {
    siteUrl: "https://yourblog.example",
    publisherName: "Your Blog",
    publisher: "https://yourblog.example/",                 // spec §5.8
    licenseServers: ["https://license.example"],            // spec §7.1 authorization_servers
    terms: { url: "https://yourblog.example/terms/", type: "text/html" },   // spec §6.1
    scopes: [
      {
        scope: "https://yourblog.example/posts/",           // spec §5.5: covers every URL under it
        offers: [
          {
            id: "monthly",
            name: "Your Blog, monthly",
            payment: { type: "subscription", amount: "5.00", currency: "USD", period: "P1M" },
            purchase_url: "https://yourblog.example/subscribe/",
            entitlement_types: ["access"],
          },
        ],
      },
    ],
    // clientPolicy: { allow: [{ domain: "*" }] },          // optional, spec §7.1
  });
}
```

Keep this object in its own file (the demo uses `ope.config.js`) so your server reads the same settings.

## Gate a post

```yaml
---
ope_gated: true
ope_offers:                   # optional: Offers for this post only, added to its scope's
  - id: "item-this-post"
    name: "This post only"
    payment: { type: "purchase", amount: "2.00", currency: "USD" }
    purchase_url: "/subscribe/"           # site-relative is fine; it's made absolute
    entitlement_types: ["access"]
---
```

## What it writes

| Path | Contents |
|---|---|
| `/.well-known/oauth-protected-resource/<scope path>` | Scope metadata, one per scope (RFC 9728 §3.1 placement) |
| `/.well-known/oauth-protected-resource/<post path>` | Per-URL metadata, only for posts with `ope_offers` |
| `/_ope/gated.json` | `{ "<url>": { title, full, preview, metadata? } }` for your server |

Each metadata document is written as a folder `index.html` so static hosts serve it at the slashless URL. Serve `/.well-known/*` as `application/json` with `Access-Control-Allow-Origin: *` (the demo's `netlify.toml` does).

You render the full and preview versions of each post yourself. The demo writes full posts under `/_ope/full/` (`src/ope-full.njk`) and keeps that path unreachable except through the gate.

## For templates

- Global data `ope`: your config plus `version: "0.2"`.
- Collections: `opeGated` (gated posts) and `opeItemOffers` (gated posts with Offers of their own).
- Filters: `opeJson`, `opeAbsolute` (site-relative to absolute), `opeItemOffers(post)` (a post's Offers with defaults filled in), `opePreview(content, chars)`, `opeWordCount`, `opeReadTime`.

The demo's `src/feed.njk` uses these for the feed's `_ope` blocks.

## Exports for servers and tests

```js
const { scopeMetadata, itemMetadata, scopeFor, metadataPath, OPE_VERSION } = require("eleventy-plugin-ope");
```

These build the same documents the site publishes.
