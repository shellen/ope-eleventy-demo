# ope-reader

A minimal **OPE reader** demo — zero dependencies, runs with Node.js 18+.

This script walks through the full OPE lifecycle from a reader's point of view:

1. **Discover** — fetches `/.well-known/ope` from the publisher
2. **Browse** — fetches the JSON Feed, lists free and gated items
3. **Subscribe** — requests a grant token from the gateway
4. **Read** — uses the grant to fetch full gated content from the publisher
5. **Refresh** — refreshes the grant token before it expires
6. **Revoke** — revokes the grant (e.g., unsubscribe)

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

## What you'll see

```
──────────────────────────────────────────────────────────
  Step 1 — Discover publisher via /.well-known/ope
──────────────────────────────────────────────────────────

  Publisher OPE config:
    Version:          0.1
    Content endpoint: https://example.com/api/content/{id}
    Token format:     jwt
    ...

──────────────────────────────────────────────────────────
  Step 2 — Fetch the JSON Feed
──────────────────────────────────────────────────────────

  Feed: "OPE Demo Blog"
  Items: 4

  [FREE]  Why Feeds Matter
  [GATED] Protocol Economics
  ...

──────────────────────────────────────────────────────────
  Step 3 — Acquire a grant token from the gateway
──────────────────────────────────────────────────────────

  Status:     granted
  Grant type: subscription
  ...
```

## No dependencies

This demo uses only the built-in `fetch` API available in Node.js 18+. No npm install required.
