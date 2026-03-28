# OPE Demo Suite

Working implementations of every layer in the [Open Portable Entitlement (OPE)](https://feedspec.org) architecture — publisher, gateway, and reader — so you can see the full protocol in action with running code.

Aligned with **OPE spec v0.1** (March 2026).

## What's in this repo

```
ope-blog/                ← Publisher: Eleventy blog with OPE-enabled feeds + content API
ope-gateway/             ← Gateway:   Express server that issues/refreshes/revokes JWT grants
ope-reader/              ← Reader:    Zero-dep Node.js script that walks the full OPE lifecycle
eleventy-plugin-ope/     ← Plugin:    Reusable Eleventy plugin for adding OPE to any blog
```

### How OPE works

OPE separates four concerns: content, distribution, entitlement, and payments (spec Section 3). This repo demonstrates the first three. Payments are explicitly out of scope — OPE proves access, it doesn't move money.

```
┌──────────┐       ┌──────────┐       ┌──────────┐
│  Reader   │──1──►│ Publisher │       │ Gateway  │
│           │◄─2───│ (blog)   │       │          │
│           │──3──►│          │       │          │
│           │◄─4───│          │       │          │
│           │──5─────────────────────►│          │
│           │◄─6─────────────────────┤│          │
│           │──7──►│          │       │          │
│           │◄─8───│          │       │          │
└──────────┘       └──────────┘       └──────────┘

1. GET /.well-known/ope        → Discover publisher capabilities (§6)
2. ← Discovery document        (content endpoint, token mode, plans, broker support)
3. GET /feed.json              → Fetch JSON Feed with OPE extensions (§9)
4. ← Feed with gated items     (previews, content_metadata, resource_type, unlock_url)
5. POST /api/entitlement/grant → Request grant + refresh token (§8)
6. ← JWT grant token            (14 grant types: subscription, trial, bundle, ...)
7. GET /api/content/{id}       → Fetch gated content with Bearer token (§10)
8. ← Full content               (articles, podcasts, video — resource-agnostic)
```

---

## Quick start: run the full demo

You need three terminals. All components share the same JWT secret.

```bash
export OPE_JWT_SECRET=dev-secret-change-me
```

**Terminal 1 — Publisher** (Eleventy blog on port 8080)

```bash
cd ope-blog
npm install
npm run dev
```

**Terminal 2 — Gateway** (Express on port 4000)

```bash
cd ope-gateway
npm install
npm start
```

**Terminal 3 — Reader** (runs the full lifecycle and exits)

```bash
cd ope-reader
node reader.js
```

The reader will discover the publisher, fetch the feed, acquire a grant from the gateway, fetch gated content, refresh the token (with rotation), and revoke it — printing every step with spec section references.

---

## Publisher: ope-blog

A complete Eleventy blog with:

- **JSON Feed** (`/feed.json`) with OPE extension blocks including `resource_type`, `unlock_url`, and `per_item_price` (spec §9.1)
- **Discovery endpoint** (`/.well-known/ope`) with `max_ttl_seconds`, `batch_endpoint`, `broker_support` (spec §6)
- **Content API** (Netlify function at `/api/content/{id}`) with spec-aligned error responses (`error`, `error_description`, `ope_discovery`) (spec §10.3)
- **Build-time content store** — gated post content compiled to JSON with `resource_type`
- **Sample posts** — mix of free and gated content with OPE frontmatter

Posts are gated with frontmatter:

```yaml
---
ope_gated: true
ope_content_id: protocol-economics
ope_level: subscriber
ope_resource_type: article
ope_cta: "Subscribe for $5/month to read the full essay"
ope_grants:
  - subscription
  - gift
---
```

See [`ope-blog/README.md`](./ope-blog/README.md) for deployment details.

---

## Gateway: ope-gateway

A sample Express server implementing the OPE gateway endpoints:

| Endpoint | Method | Spec section | What it does |
|----------|--------|-------------|-------------|
| `/api/entitlement/grant` | POST | §8 | Issue a JWT grant token + refresh token |
| `/api/entitlement/refresh` | POST | §12.3 | Refresh with token rotation |
| `/api/entitlement/revoke` | POST | §12.2 | Revoke with reason code |
| `/.well-known/ope` | GET | §6 | Gateway discovery document |

Supports all 14 grant types from the spec (§21): `subscription`, `per_item`, `gift`, `institutional`, `metered`, `locale_free`, `patronage`, `broker`, `trial`, `rental`, `bundle`, `ad_supported`, `early_access`, `family`.

Try it with curl:

```bash
# Get a subscription grant
curl -s http://localhost:4000/api/entitlement/grant \
  -H "Content-Type: application/json" \
  -d '{"user_id": "alice", "grant_type": "subscription"}' | jq

# Use the grant_token to fetch gated content from the publisher
TOKEN=$(curl -s http://localhost:4000/api/entitlement/grant \
  -H "Content-Type: application/json" \
  -d '{"user_id": "alice", "grant_type": "subscription"}' | jq -r .grant_token)

curl -s http://localhost:8080/api/content/protocol-economics \
  -H "Authorization: Bearer $TOKEN" | jq

# Try a trial grant
curl -s http://localhost:4000/api/entitlement/grant \
  -H "Content-Type: application/json" \
  -d '{"user_id": "bob", "grant_type": "trial"}' | jq
```

See [`ope-gateway/README.md`](./ope-gateway/README.md) for all options.

---

## Reader: ope-reader

A zero-dependency Node.js script (requires Node 18+ for built-in `fetch`) that demonstrates the complete OPE lifecycle:

1. **Discover** — `GET /.well-known/ope` (§6)
2. **Browse** — `GET /feed.json`, show `resource_type`, `unlock_cta`, `per_item_price` (§9)
3. **Subscribe** — `POST /api/entitlement/grant` to the gateway (§8)
4. **Read** — `GET /api/content/{id}` with the JWT, handle `media` objects (§10)
5. **Refresh** — `POST /api/entitlement/refresh` with token rotation (§12.3)
6. **Revoke** — `POST /api/entitlement/revoke` with reason code (§12.2)

```bash
node ope-reader/reader.js
node ope-reader/reader.js --user alice --content protocol-economics
```

See [`ope-reader/README.md`](./ope-reader/README.md) for all options.

---

## Eleventy Plugin: eleventy-plugin-ope

A reusable plugin you can drop into any Eleventy blog. Provides:

- Global `ope` data object for templates
- Filters: `opePreview`, `opeWordCount`, `opeReadTime`, `jsonEscape`
- JWT helpers: `createGrant()`, `verifyGrant()`

```js
// eleventy.config.js
const opePlugin = require("./plugins/eleventy-plugin-ope");

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(opePlugin, {
    siteUrl: "https://yourblog.com",
    publisherName: "Your Blog",
    plans: [
      { id: "monthly", name: "Monthly", currency: "USD", amount: 500 },
    ],
  });
}
```

See [`eleventy-plugin-ope/README.md`](./eleventy-plugin-ope/README.md) for the full API.

---

## Spec coverage

This demo suite covers:

| Spec section | Feature | Implemented in |
|-------------|---------|---------------|
| §6 | Discovery (`/.well-known/ope`) | ope-blog, ope-gateway |
| §8 | Grant tokens (all 14 types, JWT) | ope-gateway |
| §9.1 | JSON Feed extensions (`content_metadata`, `resource_type`, `unlock_url`) | ope-blog |
| §10.1 | Single content retrieval | ope-blog (content API) |
| §10.3 | Structured error responses | ope-blog (content API) |
| §12.2 | Token revocation with reason | ope-gateway |
| §12.3 | Refresh token rotation | ope-gateway, ope-reader |
| §13 | Multi-publisher session management | ope-reader (per-publisher design) |
| §19 | Implementer guide reference architecture | all components |
| §22 | Worked example flow | ope-reader |

Not yet implemented (future work):
- §7: Full OAuth 2.0 + PKCE (this demo uses simplified auth for clarity)
- §10.2: Batch content retrieval endpoint
- §11: Web-based entitlement (HTTP 402, cookie transport, browser unlock)
- §14: Entitlement brokers
- §15: AT Protocol integration

## Spec

[Open Portable Entitlement specification v0.1](https://feedspec.org/ope)

## License

MIT
