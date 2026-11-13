# OPE and atproto spaces

A single page, with no build step and no dependencies, showing how a publisher on the AT Protocol could keep subscriber-only posts in an **atproto space**, with an **OPE License Server** deciding who may read them. The decision comes from the same subscription that unlocks the publisher's site and every OPE app.

Open `index.html` in a browser, or see it on the demo blog at `/atproto/`.

## What it shows

- **The idea:** a space under atproto's `managedspace` policy hands each "may this account read?" decision to a managing app. The License Server is that app, and answers from the reader's OPE subscription.
- **A live address builder:** type a publisher's handle. The page resolves their DID (Bluesky's public API) and shows:
  - the space address: `at://<publisher DID>/space/<type>/<key>`;
  - a sample record address in the space;
  - the space's policy, naming the License Server as managing app;
  - the License Server's matching `OPE_MANAGED_SPACES` setting.

  It also checks that the License Server's `did:web` document resolves.
- **The flow, step by step,** and what's working versus not yet.

The License Server side is a working prototype: `ope-license-server/atproto.js` (the managing app) and `ope-license-server/atproto-oauth.js` (account linking). Unit tests are in `ope-license-server/test/`, and the end-to-end test is in `ope-license-server/integration/`.

## Status

atproto spaces are in alpha (proposal 0016, alpha since August 20, 2026), with breaking changes still landing.

**Works:**
- **Account linking by signing in.** On the License Server's account page, a subscriber signs in with their atproto account (atproto OAuth, scope `atproto`: identity only). The License Server keeps the DID, after checking that the server vouching for it is the one the DID's own PDS names, and throws the tokens away. It works on the live demo with a real Bluesky account (first linked November 12, 2026).
- **The managing app.** The License Server answers a space's access checks, with signatures checked against the space owner's DID key. It answers `checkAccess`, the proposal's name and the alpha's since November 12, and still answers `checkUserAccess`, the November 5 alpha's name.
- **The whole path, tested against Bluesky's own spaces-alpha PDS** run locally (`npm run test:spaces` in `ope-license-server`):
  1. The subscriber links their account through the PDS's real sign-in page.
  2. The publisher creates the space and writes posts into it.
  3. An app gets a space credential for the subscriber.
  4. The app reads the posts, signing each request with the credential's key (RFC 9421).

  Unsubscribed, cancelled, and unlinked readers are refused, and so is a request signed with the wrong key.

**Doesn't yet:**
- **A hosted space.** The alpha server is invite-only.
- **Live access.** The live License Server manages no space until `OPE_MANAGED_SPACES` is set.
- **A reader app for spaces.** The test plays the app.
- **Per-user checks inside apps.** A space credential lets an *app* sync the space; it doesn't say which of the app's users may see it. Under the proposal, an app serving many users decides that itself. For a paid space, OPE gives it a way: check each user's entitlement, for example with an OPE License Token for the space's Asset.
- **Early cancellation.** Only the space's authority (the publisher's PDS) can revoke a credential before it expires. So a cancellation stops new credentials at once, and a credential already issued lasts its lifetime: 10 minutes by default.
- **A stable API.**

How an app reads a managed space, as the test does it:

```js
import { P256Keypair } from "@atproto/crypto";
import { createSpaceSigHeaders } from "@atproto/space";

// 1. A delegation token from the reader's own PDS (signed in as the reader).
const { token } = await xrpc(readerPds, "com.atproto.space.getDelegationToken", { space });
// 2. A space credential from the space's host, bound to a key the app holds.
//    The host asks the License Server first.
const key = await P256Keypair.create();
const { credential } = await xrpc(spaceHost, "com.atproto.space.authorizeSpaceSync",
  { space, credentialKey: key.did(), delegationToken: token });
// 3. Read, signing each request with that key.
const { headers } = await createSpaceSigHeaders({
  keypair: key,
  authorization: `Atproto-Space-Credential ${credential}`,
  audience: publisherDid,           // the repo being read
});
await xrpc(spaceHost, "com.atproto.space.listRecords", { space, repo: publisherDid, collection }, headers);
```

The previous version of this page (OPE v0.1: a Bluesky `did:plc` as the publisher's identity, plus Constellation engagement counts) is on the `v0.1` branch.

## Sources

- [atproto permissioned data proposal (0016)](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data)
- [Spaces alpha announcement](https://atproto.com/blog/atproto-spaces-alpha)
- [OPE v0.2 draft](https://feedspec.org/ope/spec/0.2/), Profile E
