# ope-reader

A minimal **OPE reader** demo — zero dependencies, runs with Node.js 18+. Aligned with the [OPE spec v0.1](https://feedspec.org/ope).

This script walks through the full OPE lifecycle from a reader's point of view:

1. **Discover** — fetches `/.well-known/ope` from the publisher (spec Section 6)
2. **Browse** — fetches the JSON Feed, lists free and gated items with `content_metadata` (spec Section 9)
3. **Subscribe** — requests a grant token + refresh token from the gateway (spec Section 8)
4. **Read** — uses the grant to fetch full content from the publisher (spec Section 10)
5. **Refresh** — refreshes the grant with token rotation (spec Section 12.3)
6. **Revoke** — revokes the grant with a reason code (spec Section 12.2)

## Prerequisites

Start both the publisher and gateway first:

```bash
# Terminal 1 — Publisher (ope-blog on port 8080)
cd ../ope-blog
npm install && npm run dev

# Terminal 2 — Gateway (on port 4000)
cd ../ope-gateway
npm install && npm start

# Terminal 3 — Reader
cd ../ope-reader
node reader.js
```

Make sure the publisher and gateway share the same `OPE_JWT_SECRET`:

```bash
export OPE_JWT_SECRET=dev-secret-change-me
```

## Usage

```bash
# Defaults: publisher on :8080, gateway on :4000
node reader.js

# Custom URLs
node reader.js --publisher http://localhost:8080 --gateway http://localhost:4000

# Specific user and content
node reader.js --user alice --content protocol-economics
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--publisher` | `http://localhost:8080` | Publisher base URL |
| `--gateway` | `http://localhost:4000` | Gateway base URL |
| `--user` | `demo-reader` | User ID for the grant request |
| `--content` | *(first gated item)* | Content ID to fetch |

## Spec features demonstrated

- **Discovery parsing**: reads `token_mode`, `max_ttl_seconds`, `batch_endpoint`, `broker_support` (Section 6)
- **Content metadata**: shows `resource_type`, `word_count`, `estimated_read_time_minutes`, `unlock_cta`, `unlock_url`, `per_item_price` (Section 9.1.1)
- **Media content**: handles `media` object and `media_alternatives` for podcast/video content (Section 10.1)
- **Refresh token rotation**: uses `refresh_token` (not grant token) for refresh (Section 12.3)
- **Structured revocation**: revokes with reason code (Section 12.2)
- **Structured errors**: handles spec error format with `error`, `error_description`, `ope_discovery` (Section 10.3)

## No dependencies

This demo uses only the built-in `fetch` API available in Node.js 18+. No npm install required.
