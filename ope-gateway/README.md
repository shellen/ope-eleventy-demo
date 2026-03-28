# ope-gateway

A sample **OPE gateway** implementation in Node.js + Express.

In the OPE architecture, a gateway sits between readers and publishers. It manages subscriptions and issues the JWT grant tokens that readers present to publisher content APIs.

## Quick start

```bash
cd ope-gateway
npm install
npm start          # or: npm run dev (auto-restart on changes)
```

The server starts on `http://localhost:4000` by default.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPE_JWT_SECRET` | `dev-secret-change-me` | Shared secret for signing JWTs (must match the publisher) |
| `OPE_GATEWAY_ISSUER` | `http://localhost:4000` | Issuer claim in tokens |
| `PORT` | `4000` | Server port |

## Endpoints

### `GET /.well-known/ope`

Returns the OPE discovery document describing this gateway's capabilities.

### `POST /api/entitlement/grant`

Issue a new grant token.

```bash
curl -X POST http://localhost:4000/api/entitlement/grant \
  -H "Content-Type: application/json" \
  -d '{"user_id": "alice", "grant_type": "subscription"}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `user_id` | string | yes | Subscriber identifier |
| `grant_type` | string | no | `subscription` (default), `per_item`, `metered`, or `gift` |
| `content_ids` | string[] | no | Required content IDs (for `per_item` grants) |
| `meter_remaining` | number | no | Articles remaining (for `metered` grants) |
| `ttl` | number | no | Token lifetime in seconds (default: 3600) |

**Response:**

```json
{
  "status": "granted",
  "token": "eyJhbGciOiJI...",
  "grant_type": "subscription",
  "expires_at": "2026-03-28T13:00:00.000Z",
  "token_id": "grant_a1b2c3d4e5f6"
}
```

### `POST /api/entitlement/refresh`

Refresh an existing grant token before it expires.

```bash
curl -X POST http://localhost:4000/api/entitlement/refresh \
  -H "Content-Type: application/json" \
  -d '{"token": "eyJhbGciOiJI..."}'
```

### `POST /api/entitlement/revoke`

Revoke a grant token (e.g., on cancellation).

```bash
curl -X POST http://localhost:4000/api/entitlement/revoke \
  -H "Content-Type: application/json" \
  -d '{"token": "eyJhbGciOiJI..."}'
```

## How it fits together

```
Reader ──► Gateway ──► Publisher
           (this)
  1. Reader asks gateway for a grant token
  2. Gateway checks subscription status, issues JWT
  3. Reader sends JWT to publisher's content API
  4. Publisher verifies JWT, returns full content
```

This sample uses in-memory storage. In production you'd connect to a real database and payment processor.
