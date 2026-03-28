# eleventy-plugin-ope

An Eleventy plugin that adds [Open Portable Entitlement (OPE)](https://feedspec.org) support to any Eleventy blog. Aligned with **OPE spec v0.1**.

Drop it into a new or existing Eleventy site to get:

- **Global `ope` data**: `siteUrl`, `publisherName`, `plans`, `grantsSupported`, `brokerSupport`, etc. available in all templates
- **Feed filters**: `opePreview`, `opeWordCount`, `opeReadTime`, `jsonEscape` for building OPE-extended feeds
- **JWT helpers**: `createGrant` and `verifyGrant` for your serverless content API, supporting all 14 grant types

## Install

```bash
npm install eleventy-plugin-ope
```

> **Peer dependency:** requires `@11ty/eleventy` >= 2.0.

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
      { id: "annual",  name: "Annual",  currency: "USD", amount: 5000 },
    ],
    grantsSupported: ["subscription", "gift", "per_item", "metered", "trial"],
    brokerSupport: false,                  // spec §6: broker_support field
    defaultTtl: 3600,                      // token TTL in seconds
    maxTtl: 86400,                         // max allowed TTL (spec §6)
    // jwtSecret defaults to process.env.OPE_JWT_SECRET
  });

  // ... rest of your config
};
```

## Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `siteUrl` | string | `"https://example.com"` | Your site's public URL |
| `publisherName` | string | `"My Blog"` | Display name for the publisher |
| `publisherId` | string | `siteUrl` | Publisher identifier (DID or URL) |
| `jwtSecret` | string | `process.env.OPE_JWT_SECRET` | Secret for signing JWTs |
| `defaultTtl` | number | `3600` | Default token TTL in seconds |
| `maxTtl` | number | `86400` | Maximum allowed TTL (spec §6) |
| `subscribeUrl` | string | `siteUrl + "/subscribe"` | Subscribe page URL |
| `plans` | array | `[]` | Subscription plans (spec §6 metadata) |
| `grantsSupported` | array | `["subscription", "gift", "per_item"]` | Supported grant types |
| `brokerSupport` | boolean | `false` | Whether this publisher accepts broker tokens (spec §6) |

## Templates

Once the plugin is registered, a global `ope` object is available in all Nunjucks, Liquid, and JavaScript templates:

```njk
{{ ope.publisherName }}
{{ ope.siteUrl }}
{{ ope.subscribeUrl }}
{{ ope.brokerSupport }}
{{ ope.plans | dump }}
```

### OPE-extended JSON Feed (`src/feed.njk`)

```njk
---
permalink: feed.json
eleventyExcludeFromCollections: true
---
{%- set siteUrl = ope.siteUrl -%}
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "{{ ope.publisherName }}",
  "home_page_url": "{{ siteUrl }}",
  "feed_url": "{{ siteUrl }}/feed.json",
  "items": [
    {%- for post in collections.post | reverse %}
    {
      "id": "{{ post.data.ope_content_id | default(post.fileSlug) }}",
      "url": "{{ siteUrl }}{{ post.url }}",
      "title": "{{ post.data.title }}",
      {%- if post.data.ope_gated %}
      "content_text": {{ post.content | opePreview(280) | dump | safe }},
      "extensions": {
        "ope": {
          "required": { "level": "{{ post.data.ope_level | default('subscriber') }}" },
          "grants_allowed": {{ post.data.ope_grants | default(["subscription", "gift"]) | dump | safe }},
          "content_id": "{{ post.data.ope_content_id | default(post.fileSlug) }}",
          "content_metadata": {
            "resource_type": "{{ post.data.ope_resource_type | default('article') }}",
            "word_count": {{ post.content | opeWordCount }},
            "estimated_read_time_minutes": {{ post.content | opeReadTime }},
            "unlock_cta": "{{ post.data.ope_cta | default('Subscribe to read the full post') }}",
            "unlock_url": "{{ siteUrl }}{{ post.url }}?ope_unlock=1"
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
    "refresh_url": "{{ ope.siteUrl }}/api/entitlement/refresh",
    "revocation_url": "{{ ope.siteUrl }}/api/entitlement/revoke",
    "token_format": "jwt",
    "token_mode": "simple",
    "default_ttl_seconds": {{ ope.defaultTtl }},
    "max_ttl_seconds": {{ ope.maxTtl }}
  },
  "content": {
    "endpoint_template": "{{ ope.siteUrl }}/api/content/{id}",
    "batch_endpoint": "{{ ope.siteUrl }}/api/content/batch",
    "formats_available": ["html"]
  },
  "metadata": {
    "subscribe_url": "{{ ope.subscribeUrl }}",
    "plans": {{ ope.plans | dump | safe }}
  },
  "grants_supported": {{ ope.grantsSupported | dump | safe }},
  "broker_support": {{ ope.brokerSupport }}
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
ope_resource_type: article
ope_level: subscriber
ope_cta: "Subscribe for $5/month to read the full post"
ope_grants:
  - subscription
  - gift
  - per_item
ope_per_item_price:
  currency: USD
  amount: 200
---
```

### Frontmatter fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ope_gated` | boolean | yes | Whether the post is gated |
| `ope_content_id` | string | yes | Unique content identifier |
| `ope_resource_type` | string | no | Resource type: `article`, `essay`, `newsletter`, `podcast_episode`, `video`, etc. (default: `article`) |
| `ope_level` | string | no | Required access level (default: `subscriber`) |
| `ope_cta` | string | no | Call-to-action for unentitled users |
| `ope_grants` | string[] | no | Allowed grant types (default: `["subscription", "gift"]`) |
| `ope_per_item_price` | object | no | Per-item price: `{ currency: "USD", amount: 200 }` (amount in smallest unit) |

The plugin filters handle preview extraction, word counts, and read-time estimates automatically.

## JWT helpers (for serverless functions)

```js
const { createGrant, verifyGrant, GRANT_TYPES } = require("eleventy-plugin-ope");

const secret = process.env.OPE_JWT_SECRET;

// Create a subscription grant
const token = createGrant(secret, "https://yourblog.com", "user-123", "subscription", {
  ttl: 3600,
});

// Create a per-item grant scoped to specific content
const perItem = createGrant(secret, "https://yourblog.com", "user-456", "per_item", {
  contentIds: ["post-123", "post-456"],
  ttl: 3600,
});

// Create a trial grant
const trial = createGrant(secret, "https://yourblog.com", "user-789", "trial", {
  trialExpiresAt: Math.floor(Date.now() / 1000) + 7 * 86400, // 7-day trial
});

// Verify a grant token
const payload = verifyGrant(secret, token);
// → { iss, sub, scope, grant_type, iat, exp, jti, ... } or null
```

### Grant options

| Option | Type | Description |
|--------|------|-------------|
| `ttl` | number | Token lifetime in seconds (default: 3600, max: 86400) |
| `scope` | string[] | OAuth scopes (default: `["content:read"]`) |
| `contentIds` | string[] | Content IDs for `per_item`, `rental`, `bundle` grants |
| `meterRemaining` | number | Articles remaining for `metered` grants |
| `institutionalDomain` | string | Domain for `institutional` grants |
| `brokerId` | string | Broker identifier for `broker` grants |
| `trialExpiresAt` | number | Unix timestamp when trial ends for `trial` grants |
| `rentalExpiresAt` | number | Unix timestamp when rental ends for `rental` grants |
| `bundleId` | string | Bundle identifier for `bundle` grants |
| `groupId` | string | Household/group ID for `family` grants |
| `adFree` | boolean | Ad-free flag for `ad_supported` grants |

### Supported grant types (spec §21)

`subscription`, `per_item`, `gift`, `institutional`, `metered`, `locale_free`, `patronage`, `broker`, `trial`, `rental`, `bundle`, `ad_supported`, `early_access`, `family`

## Environment variables

| Variable | Description |
|----------|-------------|
| `OPE_JWT_SECRET` | Secret key for signing and verifying grant tokens. **Required in production.** |

## Full working example

See [`ope-blog/`](../ope-blog) for a complete Eleventy demo blog, and [`ope-reader/`](../ope-reader) for a browser-based demo that walks through the full OPE lifecycle.

## Spec

[Open Portable Entitlement specification v0.1](https://feedspec.org/ope)

## License

MIT
