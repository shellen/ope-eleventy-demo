# OPE Demo Suite

Working implementations of every layer in the [Open Portable Entitlement (OPE)](https://feedspec.org) architecture: publisher, gateway, and reader. See the full protocol in action with running code.

Aligned with **OPE spec v0.1** (March 2026).

## Why this exists

Specifications are necessary but not sufficient. You can read the OPE spec and understand what discovery endpoints, grant tokens, and content retrieval are supposed to do, but the distance between reading a spec and believing it works is the distance between a diagram and running code. This project exists to close that gap.

When we designed OPE, we made a bet that entitlement could be cleanly separated from payment processing and content distribution. That's an easy claim to make in a specification document. It's a harder claim to prove. So we built the simplest possible versions of all three roles in the protocol: a publisher that serves an Eleventy blog with OPE-enabled feeds, a gateway that issues and manages JWT grant tokens, and a reader that walks through the entire lifecycle from discovery to revocation. You can run all three on your laptop in one command and watch the tokens flow between them.

We deliberately kept each component small enough to read in one sitting. The gateway is a single Express server file. The reader is a single script with zero dependencies. The blog is a standard Eleventy site with a handful of templates. If you want to understand how OPE works, you shouldn't need to deploy infrastructure or study a framework. You should be able to read the code, run the demo, and start building.

## What's in this repo

```
run-demo.sh              ← One-command launcher — installs deps and starts everything
ope-blog/                ← Publisher: Eleventy blog with OPE-enabled feeds + content API
ope-gateway/             ← Gateway:   Express server that issues/refreshes/revokes JWT grants
ope-reader/              ← Reader:    Browser UI + CLI that walks the full OPE lifecycle
eleventy-plugin-ope/     ← Plugin:    Reusable Eleventy plugin for adding OPE to any blog
```

### How OPE works

OPE separates four concerns: content, distribution, entitlement, and payments (spec Section 3). This repo demonstrates the first three. Payments are explicitly out of scope. OPE proves access, it doesn't move money.

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

## Quick start: one command

```bash
./run-demo.sh
```

The script auto-generates a JWT secret for the session so all three components can sign and verify tokens. (For production, you'd generate a secret once and set it as an environment variable. See [Deploying](#deploying) below.)

This installs all dependencies and starts three services:

| Service | Port | What it is |
|---------|------|-----------|
| **Reader UI** | [localhost:3000](http://localhost:3000) | Browser-based OPE demo. Click "Run Full Demo" to walk through every step |
| **Publisher** | [localhost:8080](http://localhost:8080) | Eleventy blog with OPE-enabled feeds and content API |
| **Gateway** | [localhost:4000](http://localhost:4000) | Express server issuing/refreshing/revoking JWT grants |

Open **http://localhost:3000** in your browser and click the button. The UI walks through each OPE step visually: discovery, feed parsing, grant acquisition, content fetch, token refresh, and revocation. It shows the actual HTTP requests and responses.

Press `Ctrl+C` to stop everything.

### Manual setup (three terminals)

If you prefer to run each component separately, first generate a shared secret:

```bash
# Generate a secret (or pick any random string for local dev)
export OPE_JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

# Terminal 1 — Publisher
cd ope-blog && npm install && npm run dev

# Terminal 2 — Gateway
cd ope-gateway && npm install && npm start

# Terminal 3a — Reader CLI (prints to terminal)
cd ope-reader && node reader.js

# Terminal 3b — Reader Web UI (open http://localhost:3000)
cd ope-reader && npm install && npm run web
```

---

## Publisher: ope-blog

A complete Eleventy blog with:

- **JSON Feed** (`/feed.json`) with OPE extension blocks including `resource_type`, `unlock_url`, and `per_item_price` (spec §9.1)
- **Discovery endpoint** (`/.well-known/ope`) with `max_ttl_seconds`, `batch_endpoint`, `broker_support` (spec §6)
- **Content API** (Netlify function at `/api/content/{id}`) with spec-aligned error responses (`error`, `error_description`, `ope_discovery`) (spec §10.3)
- **Build-time content store**: gated post content compiled to JSON with `resource_type`
- **Sample posts**: mix of free and gated content with OPE frontmatter

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

Two ways to experience the OPE lifecycle:

### Browser UI (`npm run web` or via `./run-demo.sh`)

A single-page web app at **http://localhost:3000** that visually walks through each OPE step. Click "Run Full Demo" and watch each step expand with the actual HTTP requests, responses, and rendered content. You can change the user ID and grant type to experiment.

### CLI (`node reader.js`)

A zero-dependency script (Node 18+) that prints the same flow to the terminal:

```bash
node ope-reader/reader.js
node ope-reader/reader.js --user alice --content protocol-economics
```

Both demonstrate the same 6 steps: Discover (§6) → Browse feed (§9) → Acquire grant (§8) → Fetch content (§10) → Refresh with rotation (§12.3) → Revoke (§12.2).

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

---

## Deploying

### The blog (publisher)

The blog deploys to Netlify with zero configuration. The `netlify.toml`, serverless content function, and CORS headers are already set up.

1. Push the repo to GitHub
2. In Netlify, add a new site from the repo (set base directory to `ope-blog`)
3. Add the environment variable `OPE_JWT_SECRET` (generate one with `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"`)
4. Deploy

The JWT secret is a symmetric signing key. The publisher uses it to verify grant tokens, and the gateway uses it to sign them. Both sides need the same value. For the local demo, `run-demo.sh` generates one automatically. For production, generate it once, store it in your hosting platform's secrets, and share it between the publisher and gateway deployments.

Once live, anyone can browse the blog, inspect the JSON Feed with OPE extensions, and fetch the `/.well-known/ope` discovery document. The content API validates grant tokens and returns full gated content. See [`ope-blog/README.md`](./ope-blog/README.md) for detailed deployment instructions.

### The gateway (future improvement)

The gateway is a standard Express server. For a fully hosted demo where the reader UI works end-to-end against live URLs, you'd deploy the gateway to a platform that supports persistent Node.js processes:

**Railway** (recommended for simplicity):
```bash
cd ope-gateway
railway init
railway variables set OPE_JWT_SECRET=<same secret as the blog>
railway up
```

**Render:**
1. Create a new Web Service from the repo
2. Set root directory to `ope-gateway`, build command to `npm install`, start command to `node server.js`
3. Add `OPE_JWT_SECRET` as an environment variable

**Fly.io:**
```bash
cd ope-gateway
fly launch --name ope-gateway
fly secrets set OPE_JWT_SECRET=<same secret as the blog>
fly deploy
```

After deploying, update the reader's `--gateway` flag (or the reader web UI's proxy config) to point at the live gateway URL. The blog and gateway must share the same `OPE_JWT_SECRET` so the publisher can verify tokens the gateway issues.

For now, the recommended workflow is: deploy the blog to Netlify so people can see OPE in production, and run `./run-demo.sh` locally for the full three-component demo.

## Spec

[Open Portable Entitlement specification v0.1](https://feedspec.org/ope)

## License

MIT
