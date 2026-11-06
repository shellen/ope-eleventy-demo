# OPE Demo Suite

Running code for every role in [Open Portable Entitlement (OPE)](https://feedspec.org/ope/spec/0.2/): a publisher, a License Server, and two reader apps. Start them all with one command, then watch a subscription made in one place unlock a post in any app.

Aligned with **OPE spec v0.2** (proposed, open for comment). The v0.1 demo lives on the [`v0.1` branch](../../tree/v0.1).

## What OPE does, in one paragraph

A reader subscribes to a publisher once, wherever they like. Any app they use (a feed reader, a podcast app, a browser) can then prove that subscription to the publisher and get the full post, without the publisher trusting the app and without the app handling payment. v0.2 does this with standard OAuth 2.0: the publisher describes its posts and Offers with [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) metadata, a License Server issues short-lived signed tokens, and the publisher checks those tokens at each post's own URL.

## What's in this repo

```
run-demo.sh            One command: install, build, and start everything
ope-blog/              Publisher: an Eleventy blog. Posts are gated at their own URLs
ope-license-server/    License Server: an OAuth 2.0 authorization server issuing License Tokens
ope-reader/            Reader apps: a CLI and a browser UI, sharing one client library
eleventy-plugin-ope/   Plugin: generates OPE metadata and feed Offers for any Eleventy site
atproto-example/       AT Protocol identity demo (from v0.1; see below)
```

## Quick start

```bash
./run-demo.sh
```

| Service | URL | What it is |
|---|---|---|
| Reader UI | http://localhost:3000 | A browser app that reads a gated post one protocol step at a time |
| Publisher | http://localhost:8080 | The blog. Gated posts show a preview until an app presents a valid token |
| License Server | http://localhost:4000 | Sign-in, consent, a pretend checkout, and your account page at `/account` |

Or run the CLI reader in a second terminal:

```bash
cd ope-reader
node reader.js --auto alice          # fills in the demo forms for "alice"
node reader.js                       # opens the sign-in page in your browser instead
```

`run-demo.sh` creates a fresh introspection credential each run and gives it to the publisher and the License Server. That's how a revoked token stops working at the publisher right away.

## How it fits together

```
 Reader app                     Publisher (ope-blog)             License Server
 ──────────                     ────────────────────             ──────────────
 GET /posts/002/ ─────────────► 402 + WWW-Authenticate
                                  ope_scope=".../posts/"
 GET /.well-known/oauth-protected-resource/posts/ ──► metadata: Offers, Terms,
                                                      authorization_servers
 GET /.well-known/oauth-authorization-server ─────────────────────────► endpoints
 POST /register ──────────────────────────────────────────────────────► client_id
 browser → /authorize?resource=.../posts/002/ ────────────────────────► sign in, choose
 ◄──────────────────────────────────────────────────── redirect with ?code
 POST /token (PKCE + DPoP proof) ─────────────────────────────────────► license+jwt
 GET /posts/002/
   Authorization: DPoP <token>
   DPoP: <proof> ─────────────► check signature, coverage,
                                Entitlement, key, revocation ──► POST /introspect
                              ◄ 200 full post
```

The steps match [Appendix B](https://feedspec.org/ope/spec/0.2/#appendix-b-implementer-guide-informative) of the spec.

## The parts

**[ope-blog](./ope-blog/)**: An Eleventy blog with one scope (`/posts/`) and two subscription Offers. One post is also sold on its own, so it gets per-URL metadata. A gated post's URL serves a preview with a `402` until a request carries a valid token, then serves the full post. The checks (spec §11.2) live in `lib/ope-gate.js` and are shared by the local Express server and a Netlify function.

**[ope-license-server](./ope-license-server/)**: One readable file. Dynamic client registration, Authorization Code with PKCE for exactly one resource, DPoP-bound ES256 tokens, pairwise subject identifiers, refresh rotation where a replayed refresh token revokes the grant, RFC 7009 revocation, and RFC 7662 introspection that a publisher can only use for its own tokens. Everything lives in memory.

**[ope-reader](./ope-reader/)**: `ope-client.js` is the whole protocol in about 200 lines of fetch and WebCrypto, with no dependencies. The CLI and the browser app both use it. The browser app keeps its DPoP private key inside WebCrypto, where it can't be exported.

**[eleventy-plugin-ope](./eleventy-plugin-ope/)**: Add it to an Eleventy site with a scope and Offers. It writes the RFC 9728 metadata documents (per scope, plus per post where a post has Offers of its own), adds the feed's `_ope` blocks, and writes an index of gated posts for your server.

## Tests

```bash
cd ope-blog && npm test             # the publisher's checks, against a fake License Server (26 tests)
cd ope-license-server && npm test   # end to end: real publisher, License Server, and client (20 tests)
```

## Spec coverage

| Spec | Feature | Where |
|---|---|---|
| §5 | Asset identifiers, scopes, URL normalization (`%2F` refused, dot-segments resolved) | ope-blog |
| §6 | Offers and Terms, with a `sha256` digest in each token | plugin, License Server |
| §7 | RFC 9728 resource metadata (per scope and per URL), RFC 8414 with `protected_resources` | plugin, License Server |
| §8 | Dynamic registration, Auth Code + PKCE, one `resource`, consent, `iss` in the response | License Server, reader |
| §9 | `license+jwt` ES256 tokens, DPoP binding (`cnf.jkt`), the `License` scheme for unbound tokens | License Server, ope-blog |
| §10 | Entitlement claims: `access`, item and collection coverage, rentals | License Server, ope-blog |
| §11 | The six Resource Server checks, `402`/`401`/`403` with `ope_scope` challenges | ope-blog |
| §12 | Refresh rotation and replay detection, revocation, introspection with `permitted` and `revocation_reason` | License Server, ope-blog |
| §17 | Entitlement records; cancelling revokes outstanding tokens | License Server |
| Feeds profile | `_ope` blocks in JSON Feed, channel and item Offers | plugin, ope-blog |

Not in this demo yet: `limit` Entitlements end to end (the publisher counts them, but the License Server only sells `access`), group Entitlements, bundles, agents, real payment, and persistent storage. A production-grade License Server is tracked in [open-portable-entitlement#11](https://github.com/shellen/open-portable-entitlement/issues/11).

## Hosting

This branch runs locally. The hosted demo on Netlify stays on the `v0.1` branch until a License Server is hosted too: the publisher alone can't issue tokens. The publisher is ready for Netlify (`ope-blog/netlify.toml`, `functions/gate.js`). Set `OPE_SITE_URL`, `OPE_LICENSE_SERVER`, and `OPE_RS_CLIENT_SECRET` there when the time comes.

## AT Protocol

[`atproto-example/`](./atproto-example/) is a single-page demo from v0.1. It shows a Bluesky `did:plc` used as a publisher identity and pulls network-wide engagement from [Constellation](https://constellation.microcosm.blue). v0.2 identifies publishers by URL and defers AT Protocol to a future profile (Profile E), so this example is kept for reference and isn't wired into the v0.2 flow.

## Spec

[Open Portable Entitlement v0.2 (proposed)](https://feedspec.org/ope/spec/0.2/). Comments: [open-portable-entitlement#23](https://github.com/shellen/open-portable-entitlement/issues/23).

## License

MIT
