# eleventy-plugin-ope

An Eleventy plugin that adds [Open Portable Entitlement (OPE)](https://feedspec.org) support to any Eleventy blog.

Drop it into a new or existing Eleventy site to get:

- **Global `ope` data** — `siteUrl`, `publisherName`, `plans`, etc. available in all templates
- **Feed filters** — `opePreview`, `opeWordCount`, `opeReadTime`, `jsonEscape` for building OPE-extended JSON feeds
- **JWT helpers** — `createGrant` and `verifyGrant` for your serverless content API

## Install

```bash
npm install eleventy-plugin-ope
```

> **Peer dependency:** requires `@11ty/eleventy` ≥ 2.0.

## Add to your Eleventy config

```js
// eleventy.config.js (or .eleventy.js)
const opePlugin = require("eleventy-plugin-ope");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPlugin(opePlugin, {
    siteUrl: "https://yourblog.com",
    publisherName: "Your Blog",
    publisherId: "did:web:yourblog.com",   // optional, defaults to siteUrl
    subscribeUrl: "/subscribe/",           // optional
    plans: [
      { id: "monthly", name: "Monthly", currency: "USD", amount: 500 },
      { id: "annual",  name: "Annual",  currency: "USD", amount: 4000 },
    ],
    grantsSupported: ["subscription", "gift", "per_item", "metered"],
    defaultTtl: 3600,                      // token TTL in seconds
    // jwtSecret defaults to process.env.OPE_JWT_SECRET
  });

  // ... rest of your config
};
```

## Templates

Once the plugin is registered, a global `ope` object is available in all Nunjucks, Liquid, and JavaScript templates:

```njk
{{ ope.publisherName }}
{{ ope.siteUrl }}
{{ ope.subscribeUrl }}
{{ ope.plans | dump }}
```

### OPE-extended JSON Feed (`src/feed.njk`)

```njk
---
permalink: feed.json
eleventyExcludeFromCollections: true
---
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "{{ ope.publisherName }}",
  "home_page_url": "{{ ope.siteUrl }}",
  "feed_url": "{{ ope.siteUrl }}/feed.json",
  "items": [
    {%- for post in collections.post | reverse %}
    {
      "id": "{{ post.data.ope_content_id | default(post.fileSlug) }}",
      "url": "{{ ope.siteUrl }}{{ post.url }}",
      "title": "{{ post.data.title }}",
      {%- if post.data.ope_gated %}
      "content_text": {{ post.content | opePreview(280) | dump | safe }},
      "extensions": {
        "ope": {
          "required": { "level": "{{ post.data.ope_level | default('subscriber') }}" },
          "grants_allowed": {{ post.data.ope_grants | default(["subscription", "gift"]) | dump | safe }},
          "content_id": "{{ post.data.ope_content_id | default(post.fileSlug) }}",
          "content_metadata": {
            "word_count": {{ post.content | opeWordCount }},
            "estimated_read_time_minutes": {{ post.content | opeReadTime }},
            "unlock_cta": "{{ post.data.ope_cta | default('Subscribe to read the full post') }}"
          }
        }
      },
      {%- else %}
      "content_html": {{ post.content | dump | safe }},
      {%- endif %}
      "date_published": "{{ post.date.toISOString() }}"
    }{{ "," if not loop.last }}
    {%- endfor %}
  ]
}
```

### OPE discovery endpoint (`src/well-known-ope.njk`)

```njk
---
permalink: .well-known/ope
eleventyExcludeFromCollections: true
---
{
  "version": "0.1",
  "entitlement": {
    "grant_url": "{{ ope.siteUrl }}/api/entitlement/grant",
    "token_format": "jwt",
    "token_mode": "simple",
    "default_ttl_seconds": {{ ope.defaultTtl }}
  },
  "content": {
    "endpoint_template": "{{ ope.siteUrl }}/api/content/{id}",
    "formats_available": ["html"]
  },
  "metadata": {
    "subscribe_url": "{{ ope.subscribeUrl }}",
    "plans": {{ ope.plans | dump | safe }}
  },
  "grants_supported": {{ ope.grantsSupported | dump | safe }}
}
```

## Gate a post

Add OPE frontmatter to any post:

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

The plugin filters handle preview extraction, word counts, and read-time estimates automatically.

## JWT helpers (for serverless functions)

```js
const { createGrant, verifyGrant } = require("eleventy-plugin-ope");

const secret = process.env.OPE_JWT_SECRET;

// Create a grant token
const token = createGrant(secret, "https://yourblog.com", "user-123", "subscription", {
  ttl: 3600,
});

// Verify a grant token
const payload = verifyGrant(secret, token);
// → { iss, sub, scope, grant_type, iat, exp, jti, ... } or null
```

### Grant options

| option | type | description |
|--------|------|-------------|
| `ttl` | number | Token lifetime in seconds (default: 3600) |
| `contentIds` | string[] | Restrict to specific content IDs (for `per_item` grants) |
| `meterRemaining` | number | Articles remaining (for `metered` grants) |

## Environment variables

| variable | description |
|----------|-------------|
| `OPE_JWT_SECRET` | Secret key for signing and verifying grant tokens. **Required in production.** |

## Full working example

See [`ope-blog/`](../ope-blog) in this repository for a complete Eleventy demo blog using this plugin, including a Netlify serverless content API and sample posts.

## Spec

[Open Portable Entitlement specification](https://feedspec.org)

## License

MIT
