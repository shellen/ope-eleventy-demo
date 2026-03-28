# ope-gateway

A sample **OPE gateway** implementation in Node.js + Express, aligned with the [OPE spec v0.1](https://feedspec.org/ope).

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
| `OPE_GATEWAY_ISSUER` | `http://localhost:4000` | Issuer claim (`iss`) in tokens |
| `PORT` | `4000` | Server port |

## Endpoints

### `GET /.well-known/ope`

Returns the OPE discovery document (spec Section 6) describing this gateway's capabilities, including supported grant types, token mode, TTL limits, and plans.

### `POST /api/entitlement/grant`

Issue a new grant token (spec Sections 8, 22).

```bash
curl -X POST http://localhost:4000/api/entitlement/grant \
  -H "Content-Type: application/json" \
  -d '{"user_id": "alice", "grant_type": "subscription"}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `user_id` | string | yes | Subscriber identifier |
| `grant_type` | string | no | One of: `subscription`, `per_item`, `gift`, `institutional`, `metered`, `locale_free`, `patronage`, `broker`, `trial`, `rental`, `bundle`, `ad_supported`, `early_access`, `family` |
| `content_ids` | string[] | no | Scoped content IDs (for `per_item`, `rental`, `bundle`) |
| `meter_remaining` | number | no | Articles remaining (for `metered`) |
| `ttl` | number | no | Token lifetime in seconds (default: 3600, max: 86400) |
| `bundle_id` | string | no | Bundle identifier (for `bundle`) |
| `group_id` | string | no | Household/group identifier (for `family`) |
| `ad_free` | boolean | no | Ad-free flag (for `ad_supported`) |

**Response:**

```json
{
  "grant_token": "eyJhbGciOiJI...",
  "refresh_token": "ope_rt_a1b2c3...",
  "expires_in": 3600,
  "grant_type": "subscription",
  "scope": ["content:read"],
  "token_id": "grant_a1b2c3d4e5f6"
}
```

### `POST /api/entitlement/refresh`

Refresh an existing grant token with **refresh token rotation** (spec Section 12.3). The old refresh token is invalidated and a new one is returned.

```bash
curl -X POST http://localhost:4000/api/entitlement/refresh \
  -H "Content-Type: application/json" \
  -d '{"refresh_token": "ope_rt_a1b2c3..."}'
```

### `POST /api/entitlement/revoke`

Revoke a grant token (spec Section 12.2). Supports both `jti`-based and `token`-based revocation with an optional reason.

```bash
curl -X POST http://localhost:4000/api/entitlement/revoke \
  -H "Content-Type: application/json" \
  -d '{"jti": "grant_a1b2c3d4e5f6", "reason": "employee_departed"}'
```

## How it fits together

```
Reader ──► Gateway ──► Publisher
           (this)
  1. Reader asks gateway for a grant token
  2. Gateway checks subscription status, issues JWT + refresh token
  3. Reader sends JWT to publisher's content API
  4. Publisher verifies JWT, returns full content
  5. Before expiry, reader refreshes via the gateway (rotation)
```

## Spec alignment

This sample implements:
- All 14 grant types from Section 21
- Refresh token rotation (Section 12.3)
- Revocation with reason codes (Section 12.2)
- Structured error responses (Section 10.3)
- Discovery document with `max_ttl_seconds`, `batch_endpoint`, `broker_support` (Section 6)
- CORS preflight for web clients (Section 11.5)

In-memory storage is used for simplicity. In production you'd connect to a real database and payment processor.
