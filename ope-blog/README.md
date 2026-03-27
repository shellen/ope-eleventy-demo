# OPE Demo Blog

The smallest working implementation of [Open Portable Entitlement](https://feedspec.org) — an Eleventy blog with OPE-enabled feeds, a serverless content API, and JWT grant tokens.

## What this is

A static blog that demonstrates OPE's core flow:

1. **Free posts** appear in full in the feed and on the site
2. **Gated posts** show a preview in the feed with OPE extension metadata (`content_id`, `word_count`, `unlock_cta`, etc.)
3. A **serverless function** serves full content to readers that present a valid OPE grant token
4. A **discovery endpoint** at `/.well-known/ope` tells OPE-compatible readers how to authenticate and retrieve content

## Architecture

```
src/posts/*.md          → Eleventy builds HTML + JSON Feed with OPE extensions
  ↓
_site/feed.json         → JSON Feed with ope extension blocks on gated items
_site/.well-known/ope   → OPE discovery document
_site/api/content/      → _store.json (full content of gated posts, build-time)
  ↓
functions/content.js    → Netlify function validates JWT, returns full content
```

The Eleventy plugin (`plugins/eleventy-plugin-ope/`) handles everything at build time: generating the discovery endpoint, adding OPE metadata to feeds, splitting gated content into preview (public) and full (behind the API).

The content API is a single serverless function that reads the build-time content store and validates JWT grant tokens. No database, no OAuth server, no token management service.

## Quick start

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# In another terminal, create a test grant token
OPE_JWT_SECRET=devtest node scripts/create-grant.js

# Test the content API (use the token from above)
curl -H "Authorization: Bearer <token>" http://localhost:8888/api/content/protocol-economics
```

## Deploy to Netlify

```bash
# Set your secret
netlify env:set OPE_JWT_SECRET $(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Deploy
netlify deploy --prod
```

The `netlify.toml` configures the function redirect (`/api/content/*` → serverless function) and ensures `.well-known` files are served with correct headers.

## Gating a post

Add OPE frontmatter to any markdown post:

```yaml
---
title: My Premium Post
date: 2026-03-25
ope_gated: true
ope_content_id: my-premium-post
ope_level: subscriber
ope_cta: "Subscribe for $5/month to read the full post"
ope_grants:
  - subscription
  - gift
---
```

The plugin handles the rest — preview extraction, feed metadata, content store entry.

## What an OPE-compatible reader sees

When a reader like Pull Read fetches `/feed.json`, gated items look like this:

```json
{
  "id": "protocol-economics",
  "title": "Protocol Economics",
  "content_text": "Every successful protocol creates a separation…",
  "extensions": {
    "ope": {
      "required": { "level": "subscriber" },
      "grants_allowed": ["subscription", "gift"],
      "content_id": "protocol-economics",
      "content_metadata": {
        "word_count": 380,
        "estimated_read_time_minutes": 2,
        "unlock_cta": "Subscribe for $5/month to read the full essay"
      }
    }
  }
}
```

The reader detects the `ope` extension, fetches `/.well-known/ope` for discovery, authenticates the user, obtains a grant token, and uses it to fetch full content from `/api/content/protocol-economics`.

Readers without OPE support simply show the preview text and link to the post — graceful degradation.

## Grant token types

```bash
# Subscription (access to everything)
OPE_JWT_SECRET=s node scripts/create-grant.js --user alice --type subscription

# Per-item (access to one specific post)
OPE_JWT_SECRET=s node scripts/create-grant.js --user bob --type per_item --content protocol-economics

# Metered (5 articles remaining)
OPE_JWT_SECRET=s node scripts/create-grant.js --user carol --type metered --meter 5

# Gift
OPE_JWT_SECRET=s node scripts/create-grant.js --user dave --type gift --ttl 86400
```

## What this doesn't do (yet)

- **OAuth flow** — grants are created via CLI/webhook, not a full OAuth dance
- **Refresh tokens** — tokens expire and that's it; no refresh endpoint
- **Batch endpoint** — single-item retrieval only
- **Broker support** — no intermediary aggregation
- **Stripe integration** — subscribe buttons are placeholders

These are all additive. The core OPE flow (discovery → grant → content) works end to end.

## Spec

See the full [OPE specification](https://feedspec.org) for the complete protocol design.

## License

MIT
