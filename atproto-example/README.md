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

The License Server side is a working prototype (`ope-license-server/atproto.js`, tested in `ope-license-server/test/atproto.test.js`). See the License Server README.

## Status

atproto spaces are in alpha (proposal 0016, alpha since August 20, 2026), with breaking changes still landing.

**Works:**
- The License Server answers as a space's managing app, with signatures checked against the space owner's DID key.
- Tested against Bluesky's own spaces-alpha PDS, run locally (`npm run test:spaces` in `ope-license-server`): a space credential is issued only while the reader's subscription is active.

**Doesn't yet:**
- a hosted space (the alpha server is invite-only);
- verified account linking (today a handle is linked without proof; a real version would use atproto OAuth);
- an app reading the space's posts with the credential;
- a live License Server configured to manage a space;
- a stable API.

The previous version of this page (OPE v0.1: a Bluesky `did:plc` as the publisher's identity, plus Constellation engagement counts) is on the `v0.1` branch.

## Sources

- [atproto permissioned data proposal (0016)](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data)
- [Spaces alpha announcement](https://atproto.com/blog/atproto-spaces-alpha)
- [OPE v0.2 draft](https://feedspec.org/ope/spec/0.2/), Profile E
