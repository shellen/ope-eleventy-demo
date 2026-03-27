# ope-eleventy-demo

Eleventy tooling for [Open Portable Entitlement (OPE)](https://feedspec.org) — a plugin you can drop into any Eleventy blog, plus a full working demo blog you can clone and deploy.

## What's in this repo

```
eleventy-plugin-ope/   ← the Eleventy plugin (use this with any blog)
ope-blog/              ← full demo blog built on the plugin
ope-blog.tar.gz        ← tarball of the demo blog for quick download
```

---

## Option A — Add the plugin to an existing (or new) Eleventy blog

The plugin lives in [`eleventy-plugin-ope/`](./eleventy-plugin-ope). It has no Eleventy-specific build requirements; copy it or install it like any local package.

### 1. Copy the plugin into your project

```bash
# Inside your Eleventy project
cp -r /path/to/ope-eleventy-demo/eleventy-plugin-ope ./plugins/eleventy-plugin-ope
```

Or, if this package is published to npm, install it directly:

```bash
npm install eleventy-plugin-ope
```

### 2. Register the plugin

```js
// eleventy.config.js
const opePlugin = require("./plugins/eleventy-plugin-ope");
// or: const opePlugin = require("eleventy-plugin-ope");

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(opePlugin, {
    siteUrl: "https://yourblog.com",
    publisherName: "Your Blog",
    plans: [
      { id: "monthly", name: "Monthly", currency: "USD", amount: 500 },
      { id: "annual",  name: "Annual",  currency: "USD", amount: 4000 },
    ],
    grantsSupported: ["subscription", "gift", "per_item", "metered"],
  });
}
```

### 3. Add the OPE templates

Copy these source files from [`ope-blog/src/`](./ope-blog/src) into your own `src/` (or wherever your Eleventy input lives):

| file | what it does |
|------|--------------|
| `feed.njk` | JSON Feed with OPE extension blocks on gated items |
| `well-known-ope.njk` | OPE discovery document at `/.well-known/ope` |
| `content-store.11ty.js` | Build-time JSON store of full gated content |

### 4. Add the content API (optional — for Netlify)

Copy [`ope-blog/functions/content.js`](./ope-blog/functions/content.js) into your `functions/` directory and add the redirect in `netlify.toml`:

```toml
[build]
  functions = "functions"

[[redirects]]
  from = "/api/content/*"
  to   = "/.netlify/functions/content"
  status = 200
```

Set your secret before deploying:

```bash
netlify env:set OPE_JWT_SECRET $(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

### 5. Gate a post

Add OPE frontmatter to any markdown post:

```yaml
---
title: My Premium Post
date: 2026-01-01
ope_gated: true
ope_content_id: my-premium-post
ope_level: subscriber
ope_cta: "Subscribe for $5/month to read the full post"
ope_grants:
  - subscription
  - gift
---
```

See [`eleventy-plugin-ope/README.md`](./eleventy-plugin-ope/README.md) for the full plugin API.

---

## Option B — Start from the full demo blog

The [`ope-blog/`](./ope-blog) directory (also available as `ope-blog.tar.gz`) is a complete, deployable Eleventy blog. Clone or extract it, then follow the quick-start in [`ope-blog/README.md`](./ope-blog/README.md).

```bash
# Extract the tarball into a new directory
mkdir my-ope-blog && tar -xzf ope-blog.tar.gz -C my-ope-blog --strip-components=1

# Install and run
cd my-ope-blog
npm install
npm run dev
```

---

## Spec

[Open Portable Entitlement specification](https://feedspec.org)

## License

MIT
