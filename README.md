# OPE Demo Suite

Running code for every role in [Open Portable Entitlement (OPE)](https://feedspec.org/ope/spec/0.2/): a publisher, a License Server, and two reader apps. Start them all with one command, then watch a subscription made in one place unlock a post on the blog itself and in any app.

**See it live:** the [demo blog](https://ope-demo.jason-e0e.workers.dev), its [reader app](https://ope-demo.jason-e0e.workers.dev/reader/), the [space app](https://ope-demo.jason-e0e.workers.dev/space-app/) (one app, several users, each checked separately), and a [walkthrough with screenshots](https://feedspec.org/ope/demo/).

Aligned with **OPE spec v0.2** (proposed, open for comment). The v0.1 demo lives on the [`v0.1` branch](../../tree/v0.1).

## What OPE does, in one paragraph

A reader subscribes to a publisher once, wherever they like. Any app they use (a feed reader, a podcast app, a browser) can then prove that subscription to the publisher and get the full post, without the publisher trusting the app and without the app handling payment. v0.2 does this with standard OAuth 2.0: the publisher describes its posts and Offers with [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) metadata, a License Server issues short-lived signed tokens, and the publisher checks those tokens at each post's own URL.

## What's in this repo

```
run-demo.sh            One command: install, build, and start everything locally
deploy-cloudflare.sh   One command: put the publisher and the License Server online
ope-blog/              Publisher: an Eleventy blog. Posts are gated at their own URLs
ope-license-server/    License Server: an OAuth 2.0 authorization server issuing License Tokens
ope-reader/            Reader apps: a CLI and a browser UI, sharing one client library
eleventy-plugin-ope/   Plugin: generates OPE metadata and feed Offers for any Eleventy site
atproto-example/       OPE and atproto spaces: how a publisher on atproto could gate posts (prototype)
```

## Quick start

You need Node.js 20 or later.

```bash
./run-demo.sh
```

| Service | URL | What it is |
|---|---|---|
| Reader UI | http://localhost:3000 | The reader app: subscribe once, unlock posts, and watch each protocol step |
| Publisher | http://localhost:8080 | The blog. Gated posts show a preview until you subscribe on the blog, or an app presents a valid token |
| License Server | http://localhost:4000 | Sign-in, consent, a pretend checkout, and your account page at `/account` |

Or run the CLI reader in a second terminal:

```bash
cd ope-reader
node reader.js --auto alice          # fills in the demo forms for "alice"
node reader.js                       # opens the sign-in page in your browser instead
```

`run-demo.sh` creates a fresh shared secret each run and gives it to the publisher and the License Server. The publisher uses it for two things. It checks tokens at the License Server's `/introspect`, which is how a revoked token stops working right away. And it signs readers in on the blog itself (the Web profile).

State lives in memory locally, so restarting `run-demo.sh` starts over: no accounts, no subscriptions, and a new signing key.

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

On the blog itself (the Web profile), the publisher's server takes the app's place:
1. "Subscribe and read here" goes to `/_ope/unlock`, which sends the browser to the License Server's `/authorize`.
2. The License Server redirects back to `/_ope/callback`.
3. There the blog exchanges the code, authenticating with its client secret.
4. The blog keeps the token in an `HttpOnly` cookie and serves the full post.

A subscriber returning to sign in again skips the consent screen.

## The parts

**Two ways to read.** On the blog itself, "Subscribe and read here" signs you in at the License Server and unlocks the post in your browser (the spec's Web profile). In any OPE app, the same subscription unlocks the same posts; the demo's reader app is at `/reader/`.

**[ope-blog](./ope-blog/)**: An Eleventy blog with one scope (`/posts/`) and two subscription Offers. One post is also sold on its own, so it gets per-URL metadata. A gated post's URL serves a preview with a `402` until a request carries a valid token, or the blog's own access cookie, then serves the full post. The blog itself has almost no OPE code: a config file, one plugin line, and a small server entry point (a Cloudflare Worker, a Netlify Function, or Express). The checks live in the plugin.

**[ope-license-server](./ope-license-server/)**: One readable file, `app.js`, which implements:
- dynamic client registration, and the publisher's own site as a confidential client (the Web profile);
- Authorization Code with PKCE, for exactly one resource;
- DPoP-bound ES256 tokens, with pairwise subject identifiers;
- refresh rotation, where a replayed refresh token revokes the grant;
- RFC 7009 revocation, and RFC 7662 introspection that a publisher can use only for its own tokens.

It is also an atproto space's managing app (see [AT Protocol](#at-protocol)). State is kept in memory locally, in a Durable Object on Cloudflare, and in Netlify Blobs on Netlify.

**[ope-reader](./ope-reader/)**: `ope-client.js` is the whole protocol in about 200 lines of fetch and WebCrypto, with no dependencies. The CLI and the browser app both use it. The browser app is a two-pane reader with an "Under the hood" panel that logs each protocol step. It keeps its DPoP private key inside WebCrypto, where it can't be exported. The blog serves it at `/reader/`.

**[eleventy-plugin-ope](./eleventy-plugin-ope/)**: Everything a publisher needs, in four steps: install, describe your Offers, add the plugin, and add a server entry point (a Cloudflare Worker, a Netlify Function, or one line of Express). At build time it writes the RFC 9728 metadata, the feed's `_ope` blocks, and the routing, and it moves full posts out of the published site. At request time it runs the spec §11.2 checks, and the Web profile's sign-in routes (`/_ope/unlock`, `/_ope/callback`, `/_ope/leave`).

**[atproto-example](./atproto-example/)**: A page explaining how a publisher on the AT Protocol can keep subscriber-only posts in an atproto space, with the License Server deciding who reads them. It includes a live address builder. The blog serves it at `/atproto/`. Next to it, `space-app.mjs` and `space-app/` are a multi-user atproto app that checks each of its users with OPE; the blog serves the app at `/space-app/`.

## Tests

```bash
cd ope-blog && npm test                       # the publisher's checks, against a fake License Server (26 tests)
cd ope-license-server && npm test             # unit tests (21) and the end-to-end suite with a real publisher,
                                              #   License Server, and client (27), then that suite again on the Netlify shim
cd ope-license-server && npm run test:cloudflare   # the end-to-end suite in Cloudflare's local runtime
cd ope-license-server && npm run test:spaces       # OPE and atproto spaces on Bluesky's spaces-alpha PDS (19)
```

The end-to-end suite covers the Web profile too: unlocking on the blog, skipping consent for a returning subscriber, refusing a tampered sign-in, and locking posts again once the subscription is cancelled. `test:spaces` installs about 460 MB of Bluesky's alpha packages into `ope-license-server/integration/`. Its account-linking tests use Playwright when it's installed and are skipped otherwise.

## Spec coverage

| Spec | Feature | Where |
|---|---|---|
| §5 | Asset identifiers, scopes, URL normalization (`%2F` refused, dot-segments resolved) | ope-blog |
| §6 | Offers and Terms, with a `sha256` digest in each token | plugin, License Server |
| §7 | RFC 9728 resource metadata (per scope and per URL), RFC 8414 with `protected_resources` | plugin, License Server |
| §8 | Dynamic registration, Auth Code + PKCE, one `resource`, consent, `iss` in the response | License Server, reader |
| §9 | `license+jwt` ES256 tokens, DPoP binding (`cnf.jkt`), the `License` scheme for unbound tokens | License Server, ope-blog |
| §10 | Entitlement claims: `access`, item and collection coverage, rentals (supported, though the demo sells none) | License Server, ope-blog |
| §11 | The six Resource Server checks, `402`/`401`/`403` with `ope_scope` challenges | ope-blog |
| §12 | Refresh rotation and replay detection, revocation, introspection with `permitted` and `revocation_reason` | License Server, ope-blog |
| §17 | Entitlement records; cancelling revokes outstanding tokens | License Server |
| Feeds profile | `_ope` blocks in JSON Feed, channel and item Offers | plugin, ope-blog |
| Web profile | Sign-in from the publisher's server as a confidential client, an `HttpOnly` access cookie, the header-then-cookie check order | plugin, License Server, ope-blog |
| Profile E (notes) | The License Server as an atproto space's managing app, and account linking with atproto OAuth (prototype; atproto spaces are alpha) | License Server |

Not in this demo yet: `limit` Entitlements end to end (the publisher counts them, but the License Server only sells `access`), group Entitlements, bundles, agents, real accounts (sign-in takes any name), and real payment. A production-grade License Server is tracked in [open-portable-entitlement#11](https://github.com/shellen/open-portable-entitlement/issues/11).

## Put it online: one command

With a Cloudflare account (the free plan is enough):

```bash
./deploy-cloudflare.sh
```

It signs you in to Cloudflare in your browser (the only manual step), deploys the License Server and the publisher as two Workers, generates the secret they share, and then runs the reader's full flow against the live sites. When it finishes, it prints your addresses:

```
Reader app:      https://ope-demo.<your-subdomain>.workers.dev/reader/
Publisher:       https://ope-demo.<your-subdomain>.workers.dev
License Server:  https://ope-license-server.<your-subdomain>.workers.dev
```

Run it again any time to redeploy. The License Server keeps its accounts, subscriptions, and signing key in a Durable Object (the SQLite kind, which the free plan includes), so they survive redeploys. Set `OPE_LS_NAME` and `OPE_BLOG_NAME` to deploy under other Worker names, or `CLOUDFLARE_API_TOKEN` to skip the browser sign-in.

### Redeploying on every push

Workers deployed by the script aren't connected to GitHub. To redeploy on every push, as the hosted demo does, connect each Worker to the repo in the Cloudflare dashboard: Worker → Settings → Build, with path `/ope-license-server` or `/ope-blog`. The Worker names must match the `name` in each `wrangler.jsonc`. Set these in the dashboard:

| Worker | Setting | Kind | Value |
|---|---|---|---|
| `ope-license-server` | `OPE_PROTECTED_RESOURCES` | Variable | The blog's scope, for example `https://ope-demo.<subdomain>.workers.dev/posts/` |
| `ope-license-server` | `OPE_RS_CLIENT_SECRET` | Secret | A long random string, shared with the blog |
| `ope-license-server` | `OPE_SITE_NAME` | Variable, optional | The blog's name, shown when readers sign in from the blog |
| `ope-license-server` | `OPE_MANAGED_SPACES` | Variable, optional | atproto spaces to manage (see [AT Protocol](#at-protocol)) |
| `ope-demo` | `OPE_SITE_URL`, `OPE_LICENSE_SERVER` | Build variables | The blog's address and the License Server's address |
| `ope-demo` | `OPE_RS_CLIENT_SECRET` | Secret | The same secret as the License Server's. Without it, apps still work, but readers can't subscribe on the blog itself, and revocation waits for tokens to expire |

The blog's build bakes its address and the License Server's address into the published metadata, so those two are build variables, not runtime ones. Secrets survive every deploy. The License Server's config also sets `keep_vars`, so a deploy from Git keeps its dashboard variables. The blog's Worker has no runtime variables to keep.

### Adding OPE to your own site

You don't run a License Server; someone else does, the way a payment provider does. Your part is the publisher, and `eleventy-plugin-ope` reduces it to four steps: install the plugin, describe your Offers in `ope.config.js`, add the plugin to your Eleventy config, and add a small server entry point (a Cloudflare Worker, a Netlify Function, or one line of Express). See [eleventy-plugin-ope](./eleventy-plugin-ope/).

## Hosting

Both the publisher and the License Server run on Cloudflare Workers (`wrangler.jsonc` in each folder) and on Netlify (`netlify.toml`). The hosted demo uses Cloudflare. On Cloudflare the License Server keeps its state and its signing key in a Durable Object, so its only required settings are the publisher's scope and the shared secret. The [License Server](./ope-license-server/) and [blog](./ope-blog/) READMEs list every setting, including Netlify's. The two Workers call each other over public HTTP, which on a shared `workers.dev` subdomain needs the `global_fetch_strictly_public` compatibility flag; both configs set it.

## AT Protocol

[`atproto-example/`](./atproto-example/) shows how a publisher on the AT Protocol could keep subscriber-only posts in an **atproto space**, with the OPE License Server deciding who reads them. Under atproto's `managedspace` policy, a space asks a "managing app" whether each account may read. The License Server is that app, and answers from the reader's OPE subscription. The page is also on the demo blog at `/atproto/`, and the spec's Profile E notes describe the same design.

atproto spaces are in **alpha** (since August 20, 2026). Bluesky expects the launch within weeks, and breaking changes still land.

**What works**
- **Linking an account by signing in, live.** On the License Server's account page, a subscriber signs in with their atproto account (atproto OAuth, scope `atproto`: identity only). The License Server keeps the account's DID and nothing else. It first checks that the server vouching for the account is the one the account's own PDS names. This works on the live demo with a real Bluesky account: on November 12, 2026, a bsky.social account was linked there. That account is hosted on one of Bluesky's PDSes, which names bsky.social as its authorization server. Try it at `/account` on the [live License Server](https://ope-license-server.jason-e0e.workers.dev/account).
- **The managing app.** The License Server has a `did:web` identity, and answers the space host's `checkAccess` (the proposal's name, used by the alpha since November 12). It still answers `checkUserAccess`, the November 5 alpha's name, in that version's shape. It checks that each request is signed by the space's owner (atproto service auth), reading the owner's key from `plc.directory` or a `did:web` document.
- **The whole path, tested against Bluesky's own spaces-alpha PDS** run locally (`npm run test:spaces` in `ope-license-server`):
  1. A subscriber links their account through the PDS's real sign-in page.
  2. The publisher writes posts into a space naming the License Server as its managing app.
  3. The PDS asks the License Server before issuing a space credential.
  4. An app reads the posts with that credential.

  Unsubscribed, cancelled, and unlinked readers are refused. The tests run against the alpha published November 12, 2026.
- **A multi-user app that checks each user** ([`atproto-example/space-app.mjs`](./atproto-example/space-app.mjs), tested in `ope-license-server/integration/space-app.test.js`). Under the proposal, a space credential admits an *app*, not each reader. So the app syncs the space once, using one subscriber's session, and then checks each of its users separately. It shows a user the posts only while it holds a License Token for that user covering the space's Asset, and refreshes the token to re-check. Against the alpha PDS, with the real License Server:
  - a subscriber sees the posts;
  - another user of the same app, with no subscription, doesn't, though the app holds the posts;
  - a user who subscribes from the app sees them without ever linking an atproto account;
  - when a subscriber cancels, their view locks at the next check, and the app can no longer sync with their session.

  The app needs no dependencies: fetch and WebCrypto, including the RFC 9421 request signatures, which Bluesky's PDS accepts.
- **The space app, open on the blog** at [`/space-app/`](https://ope-demo.jason-e0e.workers.dev/space-app/). It is one page playing the app's server and its users (Ada, Bobby, Carol, or any you add):
  - connect each user's subscription at the License Server;
  - sync once for one subscriber;
  - switch users to see who the app shows the posts to.

  On the hosted blog the space is a labeled stand-in: no atproto space can run there, so the app syncs the blog's subscriber-only posts with one subscriber's License Token. Each user's view is still checked with their own token. Locally, `npm run space-app` in `ope-license-server/integration` serves the same page against a real space on Bluesky's alpha PDS. There, syncing is refused until the chosen user subscribes, because the License Server, as managing app, says no.
- It runs on Cloudflare Workers, alongside the rest of the License Server.

**What doesn't yet**
- **No hosted space.** It hasn't run against a space on a hosted PDS: the alpha server is invite-only.
- **A real space on the hosted blog.** The live space app uses a stand-in, and the reader app doesn't open spaces.
- **Which Asset a space stands for is configuration.** The License Server and the app are each told which OPE Asset a space corresponds to. Nothing published in the space says so yet (an open question in the spec's Profile E notes).
- **Live access isn't configured.** The live License Server doesn't manage any space until `OPE_MANAGED_SPACES` is set. A linked account has no visible effect until then.
- **Linking in local runs is untested against Bluesky.** Locally, the License Server uses atproto's loopback client (`http://localhost`), which the test exercises against the alpha PDS, but not against bsky.social.
- **Cancellation waits for credentials to expire.** Only the publisher's PDS can revoke a space credential early. When a subscription ends, the License Server refuses new credentials at once, and one already issued lasts until it expires (10 minutes by default).
- **The API may change.** Method names and shapes are still moving in the alpha.

## Spec

[Open Portable Entitlement v0.2 (proposed)](https://feedspec.org/ope/spec/0.2/). Comments: [open-portable-entitlement#23](https://github.com/shellen/open-portable-entitlement/issues/23).

## License

MIT
