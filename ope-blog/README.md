# OPE Demo Blog

The smallest working OPE v0.2 publisher: an Eleventy blog whose subscriber-only posts are gated at their own URLs. With no token, a gated post serves a preview and a `402`. With a valid License Token, it serves the full post.

## Run

```bash
npm install
npm run dev        # build, then serve on http://localhost:8080
npm test           # 26 tests: the spec §11.2 checks against a fake License Server
```

For the full flow (License Server and reader apps too), run `../run-demo.sh`.

## How it's put together

```
ope.config.js          Scope, Offers, Terms, and which License Servers may issue (one source of truth)
src/posts/*.md         Posts. ope_gated: true gates one; ope_offers adds Offers of its own
eleventy.config.js     Adds eleventy-plugin-ope with ope.config.js
lib/ope-gate.js        The Resource Server checks (spec §11.2), framework-independent
server.js              Local server: URL normalization, then the gate, then static files
functions/gate.js      The same gate as a Netlify function
```

The build writes:

| Output | What it is |
|---|---|
| `/.well-known/oauth-protected-resource/posts/` | Scope metadata (RFC 9728): License Servers, Publisher, Offers, Terms |
| `/.well-known/oauth-protected-resource/posts/004-building-for-readers/` | Per-URL metadata for the post that's also sold on its own |
| `/feed.json` | JSON Feed with `_ope` blocks: channel Offers, and each gated item's `resource` |
| `/posts/<slug>/` | For gated posts, the preview page |
| `/_ope/full/posts/<slug>/` | The full post. Never served directly; the gate reads it |
| `/_ope/gated.json` | Which paths are gated, read by the servers |
| `/terms/` | The Terms. Tokens carry its SHA-256 digest |

## Gating a post

```yaml
---
title: Building for Readers, Not Platforms
ope_gated: true
ope_offers:                     # optional: Offers for this post on top of the scope's
  - id: "item-building-for-readers"
    name: "Building for Readers (this article only)"
    payment: { type: "purchase", amount: "2.00", currency: "USD" }
    purchase_url: "/subscribe/"
    entitlement_types: ["access"]
---
```

## The checks

`lib/ope-gate.js` runs on every request for a gated path, in spec order:

1. Refuse `%2F` and `%5C` in the path (`400`). `server.js` also resolves dot-segments and decodes unreserved characters first, so `/posts/x/../../_ope/full/…` can't reach a full post.
2. No token, or a `Bearer` token: `402` with a challenge for each scheme. The challenge carries `ope_scope`, or `resource_metadata` for a post with its own metadata.
3. Signature (ES256, keys from the License Server's JWKS, refetched at least every 5 minutes), `typ: license+jwt`, an issuer listed in our metadata, `aud`, `exp`.
4. Coverage: the token's `resource` and `coverage` include this post, and `publisher` is this site (`403 insufficient_scope`).
5. The Entitlement permits serving: `access` or `limit`, and a rental hasn't ended (`403 no_entitlement`).
6. Sender constraint: a bound token needs a DPoP proof for this method and URL, signed by the key in `cnf.jkt`, not replayed.
7. Revocation: when the token has more than `OPE_TOLERANCE_SECONDS` (default 300) left, ask the License Server's `/introspect`.

Then it serves the full post, or JSON (`url`, `title`, `content_html`) when the request asks for `application/json`.

## Configuration

| Variable | Default | What it is |
|---|---|---|
| `OPE_SITE_URL` | `http://localhost:8080` | The site's origin. Asset identifiers and metadata are built from it |
| `OPE_LICENSE_SERVER` | `http://localhost:4000` | The License Server listed in `authorization_servers` |
| `OPE_RS_CLIENT_ID` / `OPE_RS_CLIENT_SECRET` | `ope-demo-blog` / none | Introspection credential. Without it, revocation only takes effect at token expiry |
| `OPE_TOLERANCE_SECONDS` | `300` | How much remaining lifetime is accepted without introspection |
| `PORT` | `8080` | |

The spec requires `https` Asset identifiers (§5.2). The local demo uses `http://localhost` so it runs without certificates. Set `OPE_SITE_URL` to an `https` origin anywhere else.

## Netlify

`netlify.toml`, `src/_redirects.njk` (routes each gated post to `functions/gate.js` and blocks `/_ope/*`), and the function are ready. The hosted demo stays on the `v0.1` branch until a License Server is hosted too. To deploy this version, set `OPE_SITE_URL`, `OPE_LICENSE_SERVER`, and `OPE_RS_CLIENT_SECRET` in Netlify's environment, with the base directory `ope-blog`.
