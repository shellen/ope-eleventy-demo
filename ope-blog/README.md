# OPE Demo Blog

The smallest working OPE publisher: an Eleventy blog with OPE-enabled feeds, a JWT-gated content API, and grant tokens. Aligned with [OPE spec v0.1](https://feedspec.org/ope). Works locally with a built-in Express server and deploys to Netlify with a serverless function.

## What this is

A static blog that demonstrates OPE's publisher role:

1. **Free posts** appear in full in the feed and on the site
2. **Gated posts** show a preview in the feed with OPE extension metadata (`content_id`, `resource_type`, `word_count`, `unlock_cta`, `per_item_price`, etc.)
3. A **content API** serves full content to readers that present a valid JWT grant token (Express server locally, Netlify function in production)
4. A **discovery endpoint** at `/.well-known/ope` tells readers how to authenticate and retrieve content

## Live demo

The blog is deployed at **https://ope-demo.netlify.app** (or wherever you deploy it). Once live, you can inspect the OPE endpoints directly:

- Blog: https://ope-demo.netlify.app
- JSON Feed: https://ope-demo.netlify.app/feed.json
- OPE Discovery: https://ope-demo.netlify.app/.well-known/ope

To test the full reader flow (discover, subscribe, read, refresh, revoke), clone the repo and run `./run-demo.sh` from the root. The reader web UI at `http://localhost:3000` walks through every step visually.

## Architecture

```
src/posts/*.md          > Eleventy builds HTML + JSON Feed with OPE extensions
  |
_site/feed.json         > JSON Feed with OPE extension blocks on gated items
_site/.well-known/ope/  > OPE discovery document (spec Section 6)
_site/api/content/      > _store.json (full content of gated posts, build-time)
  |
server.js               > Local Express server: static files + content API with JWT validation
functions/content.js    > Netlify serverless function: same content API for production
```

The Eleventy plugin (`plugins/eleventy-plugin-ope/`) handles everything at build time: generating the discovery endpoint, adding OPE metadata to feeds, splitting gated content into preview (public) and full (behind the API).

The content API reads the build-time content store and validates JWT grant tokens. No database, no OAuth server, no token management service. Locally, `server.js` serves both static files and the API. On Netlify, `functions/content.js` handles the API while the CDN serves static files.

## Quick start (local)

```bash
npm install

# Build the static site and start the Express server on port 8080
npm run dev

# In another terminal, create a test grant token
OPE_JWT_SECRET=dev-secret-change-me node scripts/create-grant.cjs

# Test the content API (use the token from above)
curl -H "Authorization: Bearer <token>" http://localhost:8080/api/content/protocol-economics
```

Or run `npm test` to build the site and run the test suite (10 tests covering static serving, JWT validation, scope checking, and per-item grants).

## Deploy to Netlify

The blog is ready to deploy to Netlify out of the box.

**Option A: Deploy from the Netlify UI**

1. Push this repo to GitHub
2. In Netlify, click "Add new site" > "Import an existing project"
3. Select the repo and set the base directory to `ope-blog`
4. Netlify auto-detects the build settings from `netlify.toml`
5. Add the environment variable: `OPE_JWT_SECRET` = any random string (used to verify grant tokens)
6. Deploy

**Option B: Deploy from the CLI**

```bash
cd ope-blog
npm install -g netlify-cli
netlify init

# Set the JWT secret
netlify env:set OPE_JWT_SECRET $(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Deploy
netlify deploy --prod
```

The `netlify.toml` configures the function redirect (`/api/content/*` to the serverless function) and ensures `.well-known` files are served with correct headers.

### What you get after deploying

| URL | What it serves |
|-----|---------------|
| `/` | Blog homepage with free and gated posts |
| `/feed.json` | JSON Feed 1.1 with OPE extensions on gated items |
| `/.well-known/ope` | OPE discovery document (spec Section 6) |
| `/api/content/{id}` | Gated content API, requires Bearer token |
| `/subscribe/` | Subscription page with plans from the OPE config |

Any OPE-compatible reader can discover this blog, parse the feed, and present gated content with subscribe prompts. The content API validates grant tokens and returns full HTML to entitled readers.

## Gating a post

Add OPE frontmatter to any markdown post:

```yaml
---
title: My Premium Post
date: 2026-03-25
ope_gated: true
ope_content_id: my-premium-post
ope_resource_type: article
ope_level: subscriber
ope_cta: "Subscribe for $5/month to read the full post"
ope_grants:
  - subscription
  - gift
  - per_item
  - trial
ope_per_item_price:
  currency: USD
  amount: 200
---
```

The plugin handles the rest: preview extraction, feed metadata, content store entry.

## What an OPE-compatible reader sees

When a reader fetches `/feed.json`, gated items include the OPE extension block:

```json
{
  "id": "protocol-economics",
  "title": "Protocol Economics",
  "content_text": "Every successful protocol creates a separation...",
  "extensions": {
    "ope": {
      "required": { "level": "subscriber" },
      "grants_allowed": ["subscription", "gift", "trial"],
      "content_id": "protocol-economics",
      "content_metadata": {
        "resource_type": "essay",
        "word_count": 380,
        "estimated_read_time_minutes": 2,
        "unlock_cta": "Subscribe for $5/month to read the full essay",
        "unlock_url": "https://ope-demo.netlify.app/posts/protocol-economics/?ope_unlock=1"
      }
    }
  }
}
```

The reader detects the `ope` extension, fetches `/.well-known/ope` for discovery, authenticates the user, obtains a grant token, and uses it to fetch full content from `/api/content/protocol-economics`.

Readers without OPE support simply show the preview text and link to the post. Graceful degradation.

## Grant token types

```bash
# Subscription (access to everything)
OPE_JWT_SECRET=s node scripts/create-grant.cjs --user alice --type subscription

# Per-item (access to one specific post)
OPE_JWT_SECRET=s node scripts/create-grant.cjs --user bob --type per_item --content protocol-economics

# Trial (7-day free trial)
OPE_JWT_SECRET=s node scripts/create-grant.cjs --user carol --type trial --trial-days 7

# Metered (5 articles remaining)
OPE_JWT_SECRET=s node scripts/create-grant.cjs --user dave --type metered --meter 5

# Gift (24-hour access)
OPE_JWT_SECRET=s node scripts/create-grant.cjs --user eve --type gift --ttl 86400

# See all options
OPE_JWT_SECRET=s node scripts/create-grant.cjs --help
```

## Spec

See the full [OPE specification](https://feedspec.org/ope) for the complete protocol design.

## License

MIT
