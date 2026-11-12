# ope-license-server

A readable OPE v0.2 License Server: an OAuth 2.0 authorization server that issues License Tokens. The server is one file (`app.js`), and each section names the spec section it implements. `server.js` runs it locally; `cloudflare/worker.mjs` runs it on Cloudflare Workers, and `netlify/functions/ls.mjs` on Netlify. Read it next to the [spec](https://feedspec.org/ope/spec/0.2/).

It's a teaching implementation. Sign-in takes any name with no password, and "checkout" is a button. State lives in memory locally, in a Durable Object on Cloudflare, and in one Netlify Blobs entry on Netlify. A production-grade server is tracked in [open-portable-entitlement#11](https://github.com/shellen/open-portable-entitlement/issues/11).

## Run

```bash
npm install
OPE_RS_CLIENT_SECRET=dev-secret npm start      # http://localhost:4000
npm test                                        # unit tests, then the end-to-end suite twice: locally, and through the Netlify Function with Blobs
npm run test:cloudflare                         # the end-to-end suite against the Cloudflare Worker, in Cloudflare's local runtime
npm run test:spaces                             # OPE and atproto spaces, against Bluesky's spaces-alpha PDS (installs ~460 MB)
```

Give the publisher the same `OPE_RS_CLIENT_SECRET`, or use `../run-demo.sh`, which does it for you.

| Variable | Default | What it is |
|---|---|---|
| `PORT` | `4000` | |
| `OPE_ISSUER` | Netlify's `URL`, else `http://localhost:$PORT` | The `iss` of every token |
| `OPE_LS_KEY` | a fresh key each start | The private signing key, as one line of JWK JSON. `npm run generate-key` prints one. Required for a hosted server |
| `OPE_PROTECTED_RESOURCES` | `http://localhost:8080/posts/` | Scopes this server issues for, comma-separated (spec §7.2) |
| `OPE_RS_CLIENT_ID` | `ope-demo-blog` | A publisher's introspection credential (spec §13.4) |
| `OPE_RS_CLIENT_SECRET` | none | Without it, introspection is off and revocation only takes effect at expiry |
| `OPE_RS_PUBLISHER` | `http://localhost:8080/` | The Publisher that credential may introspect for |
| `OPE_SUBJECT_SECRET` | derived from `OPE_LS_KEY`, else random per start | Key for pairwise subject identifiers |

## On Cloudflare

`wrangler.jsonc` and `cloudflare/worker.mjs` run the same app as a Cloudflare Worker. Every request goes to one Durable Object, which keeps the state in memory, like the local server, and writes it to its own SQLite storage after each change. On its first run it also generates the signing key and stores it there. Its issuer is the Worker's own address.

Set two things in the Worker's settings:

| Name | Type | Value |
|---|---|---|
| `OPE_PROTECTED_RESOURCES` | Variable | The publisher's scope, for example `https://ope-demo.<your-subdomain>.workers.dev/posts/` |
| `OPE_RS_CLIENT_SECRET` | Secret | A random secret. Give the publisher the same value |

`npm run dev:cloudflare` runs it in Cloudflare's local runtime, and `npm run test:cloudflare` runs the end-to-end suite against it there. Cloudflare's runtime needs Express 5, which this package uses.

## On Netlify

Create a Netlify site from this repository with base directory `ope-license-server`. `netlify.toml` routes every path to the one function. Set these in the site's environment variables:

| Variable | Value |
|---|---|
| `OPE_LS_KEY` | The output of `npm run generate-key`, run on your own machine. Treat it like a password |
| `OPE_PROTECTED_RESOURCES` | The publisher's scope, for example `https://your-blog.netlify.app/posts/` |
| `OPE_RS_PUBLISHER` | The publisher's identifier, for example `https://your-blog.netlify.app/` |
| `OPE_RS_CLIENT_SECRET` | A random secret. Give the publisher the same value |

The function loads its state from Netlify Blobs before each request and saves it after. The save only succeeds if nobody else saved in between; otherwise the request runs again on the fresher state. The response waits for the save, so concurrent requests can't lose a refresh-token rotation.

## The publisher's own site as a client (Web profile)

The publisher's site signs readers in from its own server, as a confidential client. It reuses the publisher's introspection credential (`OPE_RS_CLIENT_ID` and `OPE_RS_CLIENT_SECRET`), so there's nothing extra to configure. Its redirect URI is `<publisher>/_ope/callback`.

- **Token endpoint:** authenticates it with HTTP Basic, and issues an unbound `License` token, since the site keeps it in a cookie.
- **Consent screen:** says it's the publisher's own site, without the "unreviewed app" warning.
- **Returning subscribers:** go straight back to the site without a consent step.

## ATProto profile prototype

A prototype of the spec's future ATProto profile (Profile E notes), built against the atproto spaces alpha (proposal 0016). A publisher with an atproto space under the `managedspace` policy can set the space's `managingApp` to this License Server. The space host then asks the License Server, for each reader, whether they may read. The answer comes from the reader's OPE subscription.

- **Identity:** the server publishes a `did:web` document at `/.well-known/did.json`. Its managing-app reference is `did:web:<host>#ope_space_manager`.
- **Endpoint:** `GET /xrpc/com.atproto.managedspace.checkAccess?space=<space-ref>&repo=<reader DID>`. It requires atproto service auth from the space's authority: a JWT signed with the authority DID's key, addressed to this server and to this method. It returns `{ "read": <active subscription covering the space>, "write": false }`. A request with no `repo` (an anonymous read) gets `false` for both. The published alpha's name for it, `checkUserAccess`, is answered too.
- **Configuration:** `OPE_MANAGED_SPACES`, a JSON list of `{ "space": "at://<publisher DID>/space/<type>/<skey>", "resource": "<OPE resource>" }`. Off when unset.
- **Account linking** (`atproto-oauth.js`): on `/account`, a subscriber signs in with their atproto account. The License Server is an atproto OAuth client asking for scope `atproto`, which is identity only. It resolves the handle to a DID and a PDS, and finds the PDS's authorization server. It then sends a pushed authorization request with PKCE and a DPoP proof, and exchanges the code. It keeps the token response's `sub` (the DID) and throws the tokens away. The check that matters most: the authorization server that signed the account in must be the one the DID's own PDS names.
  - **Deployed:** the client ID is `<issuer>/oauth/atproto-client-metadata.json`.
  - **Local runs:** it uses atproto's loopback client, with the callback on `127.0.0.1`.
  - **Handles:** resolved through DNS (over HTTPS, so it works on Workers), then `/.well-known/atproto-did`.

Tested two ways:

- **`test/atproto.test.js`** plays the space host, signing requests with a generated key pair. **`test/atproto-oauth.test.js`** checks the linking client's checks, against a faked network.
- **`npm run test:spaces`** runs the License Server against **Bluesky's own spaces-alpha PDS**, in-process, using `@atproto/dev-env`. The whole path, unmocked:
  1. The subscriber links their account through the PDS's real sign-in and consent pages, driven by Playwright. A denied consent links nothing.
  2. The publisher creates a managed space naming this server, and writes posts into it.
  3. The PDS resolves our `did:web` and calls `checkUserAccess` with the publisher's service auth. It issues a space credential only while the reader's subscription is active.
  4. An app reads the posts with that credential, signing each request with its key (RFC 9421). A request signed with another key is refused.
  5. After a cancellation, no new credential is issued. A credential already issued keeps working until it expires (10 minutes): only the space's authority can revoke one early.

  Playwright is found from `integration/` or `NODE_PATH`; without it, the linking tests are skipped. It lives in `integration/`, with its own dependencies (about 460 MB), so the normal install and Cloudflare builds don't carry them. Its `package.json` pins every `@atproto` package to the alpha snapshot, because the snapshot's version ranges also match a broken `@atproto/lex@0.0.0` placeholder.

The alpha has shipped two versions of this call, and the server answers both:

| | Published alpha (Nov 5) | Bluesky's integration branch (Nov 11) |
|---|---|---|
| Method | `checkUserAccess` | `checkAccess` |
| Parameters | `space`, `user`, `access` (read or write), `clientId` | `space`, `repo` (absent for an anonymous read), `clientId` (absent for writes) |
| Answer | `{ "authorized": … }` | `{ "read": …, "write": … }` |

A space host addresses its service auth to the managing app's `did#ope_space_manager` reference, and denies access if the managing app can't be reached. DID keys are read in both the current Multikey form and the older 2019 key types. `OPE_PLC_URL` sets the PLC directory (default `https://plc.directory`). It hasn't been tested against a live, hosted space yet: the alpha server is invite-only, and the public launch is expected within weeks.

## Endpoints

| Endpoint | Spec | What it does |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` | §7.2, RFC 8414 | Endpoints, `protected_resources`, and the `ope` member |
| `GET /jwks.json` | §9.3 | The ES256 public key: a new key each local start, unless `OPE_LS_KEY` is set (on Cloudflare, generated once and kept). Publishers refetch on an unknown `kid` |
| `POST /register` | §8.2, RFC 7591 | Public clients only. Redirects must be loopback, `https`, or a private-use scheme |
| `GET /authorize` | §8.1 | Auth Code + PKCE (S256) for exactly one `resource`. Fetches the publisher's RFC 9728 metadata and checks that it lists this server |
| `POST /login`, `POST /consent` | §8.4 | Demo sign-in, then consent: the app's name and that it's unreviewed, the Offers, a Terms link, how to revoke |
| `POST /token` | §8.5, §9, §12.1 | Code exchange and refresh. A DPoP proof binds the token (`cnf.jkt`); the response includes `resource` and `entitlement` |
| `POST /revoke` | §12.2, RFC 7009 | Revoking a refresh token ends the whole authorization |
| `POST /introspect` | §12.4, RFC 7662 | Basic auth with a publisher's credential, for its own tokens only. Answers `permitted` for a `resource`, and `revocation_reason` when inactive |
| `GET /account` | §17 | Your subscriptions (cancel) and connected apps (disconnect); link an atproto account by signing in with it (prototype) |
| `POST /account/atproto/link`, `GET /account/atproto/callback`, `GET /oauth/atproto-client-metadata.json` | Profile E (notes) | Account linking with atproto OAuth, above |
| `GET /.well-known/did.json`, `GET /xrpc/com.atproto.managedspace.checkAccess` | Profile E (notes) | The ATProto profile prototype, above |

## What a token looks like

```json
{
  "iss": "http://localhost:4000",
  "sub": "s_spdXYczlc2lErooCDipk3u",
  "client_id": "app_2d36c1753a0b6565",
  "aud": ["http://localhost:8080"],
  "resource": "http://localhost:8080/posts/",
  "publisher": "http://localhost:8080/",
  "terms": { "url": "http://localhost:8080/terms/", "sha256": "_iq8HsZf…" },
  "entitlement": { "type": "access", "coverage": "collection", "duration": "recurring", "source": "direct", "offer": "monthly" },
  "cnf": { "jkt": "0QjcFB2S57LmnJqE0fRpl0GiYRJxJWjbH1dPplhEoFw" },
  "iat": 1793900000, "exp": 1793903600, "jti": "lt_…"
}
```

The header is `{"alg":"ES256","typ":"license+jwt","kid":"ls-…"}`.

## Behaviors worth knowing

- **Pairwise subjects.** `sub` is an HMAC of the account and the Publisher: the same across apps for one publisher, different across publishers, and never the account name.
- **What a token covers.** A subscription covers the scope (`coverage: "collection"`). A single purchase covers the one post (`coverage: "item"`). The token's `resource` says which.
- **Refresh rotation.** Each refresh spends the old refresh token. If a spent one comes back, someone copied it, so the whole grant is revoked and every token from it stops working.
- **Cancelling** on `/account` ends the Entitlement and revokes outstanding tokens with `revocation_reason: "entitlement_ended"`. Disconnecting an app revokes with `client_revoked`.
- **Rentals** get tokens that expire no later than the rental does.

## Not here

Real accounts and payment, a database built for more than a demo's traffic, key rotation, group and `limit` Entitlements, bundles, agent tokens (§13), and a reviewed-client list for publishers that set `client_policy`. With a `client_policy` that doesn't allow everyone, `/authorize` refuses, because no app here is reviewed.
