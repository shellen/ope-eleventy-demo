# OPE Demo Suite

Working implementations of every layer in the [Open Portable Entitlement (OPE)](https://feedspec.org) architecture — publisher, gateway, and reader — so you can see the full protocol in action without reading spec prose.

## What's in this repo

```
ope-blog/                ← Publisher: Eleventy blog with OPE-enabled feeds + content API
ope-gateway/             ← Gateway:   Express server that issues/refreshes/revokes JWT grants
ope-reader/              ← Reader:    Zero-dep Node.js script that walks the full OPE lifecycle
eleventy-plugin-ope/     ← Plugin:    Reusable Eleventy plugin for adding OPE to any blog
```

### How OPE works

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

1. GET /.well-known/ope        → Discover publisher's OPE config
2. ← Discovery document        (content endpoint, grants supported, plans)
3. GET /feed.json              → Fetch JSON Feed with OPE extensions
4. ← Feed with gated items     (previews, content IDs, metadata)
5. POST /api/entitlement/grant → Request a grant token
6. ← JWT grant token            (subscription, per_item, metered, gift)
7. GET /api/content/{id}       → Fetch gated content with Bearer token
8. ← Full content               (HTML, verified via JWT)
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

The reader will discover the publisher, fetch the feed, acquire a grant from the gateway, fetch gated content, refresh the token, and then revoke it — printing every step.

---

## Publisher: ope-blog

A complete Eleventy blog with:

- **JSON Feed** (`/feed.json`) with OPE extension blocks on gated items
- **Discovery endpoint** (`/.well-known/ope`) advertising content API, plans, and grant types
- **Content API** (Netlify function at `/api/content/{id}`) that validates JWT grants and returns full HTML
- **Build-time content store** — gated post content compiled to JSON at build time
- **Sample posts** — mix of free and gated content with OPE frontmatter

Posts are gated with frontmatter:

```yaml
---
ope_gated: true
ope_content_id: protocol-economics
ope_level: subscriber
ope_cta: "Subscribe for $5/month to read the full essay"
ope_grants:
  - subscription
  - gift
---
```

See [`ope-blog/README.md`](./ope-blog/README.md) for deployment details.

---

## Gateway: ope-gateway

A sample Express server implementing the three OPE gateway endpoints:

| Endpoint | Method | What it does |
|----------|--------|-------------|
| `/api/entitlement/grant` | POST | Issue a JWT grant token for a subscriber |
| `/api/entitlement/refresh` | POST | Refresh an existing grant before expiry |
| `/api/entitlement/revoke` | POST | Revoke a grant (e.g., on cancellation) |
| `/.well-known/ope` | GET | Gateway discovery document |

Try it with curl:

```bash
# Get a subscription grant
curl -s http://localhost:4000/api/entitlement/grant \
  -H "Content-Type: application/json" \
  -d '{"user_id": "alice", "grant_type": "subscription"}' | jq

# Use the token to fetch gated content from the publisher
TOKEN=$(curl -s http://localhost:4000/api/entitlement/grant \
  -H "Content-Type: application/json" \
  -d '{"user_id": "alice", "grant_type": "subscription"}' | jq -r .token)

curl -s http://localhost:8080/api/content/protocol-economics \
  -H "Authorization: Bearer $TOKEN" | jq
```

See [`ope-gateway/README.md`](./ope-gateway/README.md) for all options.

---

## Reader: ope-reader

A zero-dependency Node.js script (requires Node 18+ for built-in `fetch`) that demonstrates the complete OPE lifecycle:

1. **Discover** — `GET /.well-known/ope`
2. **Browse** — `GET /feed.json`, list free vs. gated items
3. **Subscribe** — `POST /api/entitlement/grant` to the gateway
4. **Read** — `GET /api/content/{id}` with the JWT
5. **Refresh** — `POST /api/entitlement/refresh`
6. **Revoke** — `POST /api/entitlement/revoke`

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

## Spec

[Open Portable Entitlement specification](https://feedspec.org)

## License

MIT
