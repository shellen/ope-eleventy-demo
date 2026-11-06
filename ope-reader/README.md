# ope-reader

Two OPE v0.2 reader apps, a CLI and a browser UI, built on one client library.

`ope-client.js` is the protocol from an app's side, in about 200 lines with no dependencies: discovery from a `402` challenge, dynamic registration, PKCE, DPoP proofs, the token exchange, presenting the token, refresh, and revocation. It uses only `fetch` and WebCrypto, so the same file runs in Node 20+ and in browsers.

## CLI

```bash
node reader.js                          # opens the License Server's sign-in page in your browser
node reader.js --auto alice             # fills in the demo forms as "alice", choosing the monthly Offer
node reader.js --auto alice --offer annual
node reader.js --auto bob --post 004 --offer item-building-for-readers   # buy one post
node reader.js --no-dpop                # an unbound token, sent with the License scheme
node reader.js --keep                   # leave the authorization in place at the end
node reader.js --publisher http://localhost:8080
```

It walks [spec Appendix B](https://feedspec.org/ope/spec/0.2/#appendix-b-implementer-guide-informative) and prints each step:

1. Read the feed: which posts are gated, and the Offers
2. Ask for a gated post with no token: `402`, and a challenge pointing to its metadata
3. Register with the License Server
4. Sign in and choose an Offer (a loopback redirect catches the code)
5. Exchange the code for a DPoP-bound `license+jwt`
6. Read the post at its own URL
7. Show that a copied token fails without the app's key
8. Refresh, then revoke, and show the publisher refusing the token

`--auto` uses `auto-consent.js` to submit the demo forms directly. A real app opens the authorization URL in the person's browser.

## Browser UI

```bash
npm install && npm run web              # http://localhost:3000
```

The same steps, one card at a time, showing the requests and responses. Sign-in opens in a popup. The DPoP private key is created non-extractable inside WebCrypto, so page script can sign with it but can't read it.

The same page is also copied into the publisher site at `/reader/` (see `ope-blog/eleventy.config.js`). There it is plain static files and needs no proxy, since it's on the publisher's own origin. That's the version the hosted demo uses.

The browser calls the License Server directly; its public endpoints allow any origin. Requests to the publisher go through `web.js`, which forwards only to the publisher's origin and passes `Authorization`, `DPoP`, and `Accept` through. Each DPoP proof still names the publisher's URL.
