# ope-reader

A minimal **OPE reader** demo with both a **browser UI** and a **CLI**. Aligned with the [OPE spec v0.1](https://feedspec.org/ope).

Both interfaces walk through the full OPE lifecycle:

1. **Discover** — fetches `/.well-known/ope` from the publisher (spec Section 6)
2. **Browse** — fetches the JSON Feed, lists free and gated items with `content_metadata` (spec Section 9)
3. **Subscribe** — requests a grant token + refresh token from the gateway (spec Section 8)
4. **Read** — uses the grant to fetch full content from the publisher (spec Section 10)
5. **Refresh** — refreshes the grant with token rotation (spec Section 12.3)
6. **Revoke** — revokes the grant with a reason code (spec Section 12.2)

## Easiest: use the top-level launcher

From the repo root:

```bash
./run-demo.sh
```

This starts the publisher, gateway, and reader web UI together. Open **http://localhost:3000** and click "Run Full Demo."

## Browser UI

The web UI is a single-page app that visually walks through each OPE step. Each step shows the actual HTTP request and response, and the gated article is rendered inline.

```bash
# Start publisher + gateway first (see below), then:
cd ope-reader
npm install
npm run web
# Open http://localhost:3000
```

You can change the **User ID** and **Grant type** in the UI to experiment with different scenarios (e.g., try `trial`, `per_item`, `gift`).

## CLI

The CLI prints the same flow to the terminal — no dependencies required (Node 18+):

```bash
cd ope-reader
node reader.js
```

## Prerequisites

Start both the publisher and gateway first:

```bash
# Terminal 1 — Publisher (ope-blog on port 8080)
cd ../ope-blog
npm install && npm run dev

# Terminal 2 — Gateway (on port 4000)
cd ../ope-gateway
npm install && npm start
```

Make sure the publisher and gateway share the same `OPE_JWT_SECRET`:

```bash
export OPE_JWT_SECRET=dev-secret-change-me
```

## CLI options

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
