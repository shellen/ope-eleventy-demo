# AT Protocol + OPE Identity Demo

> **From OPE v0.1.** v0.2 identifies publishers by URL and defers AT Protocol to a
> future profile (Profile E, waiting on atproto spaces). This example is kept for
> reference and isn't part of the v0.2 flow. Its `publisherId` is a v0.1 concept.

A zero-dependency, single-file demo showing how AT Protocol (Bluesky) identities
integrate with OPE's portable entitlement model.

## What it does

- Fetches any Bluesky user's profile and recent posts via the **public API** (no auth)
- Queries **Constellation** (by [Microcosm](https://www.microcosm.blue/)) for
  network-wide interaction counts from the AT Protocol firehose
- Shows how a `did:plc` identity maps directly to an OPE `publisherId`

## Run it

Open `index.html` in a browser. That's it. No build step, no dependencies, no server.

You can also link directly to a profile: `index.html#jay.bsky.team`

## APIs used

| API | Base URL | Auth | Purpose |
|-----|----------|------|---------|
| Bluesky Public AppView | `https://public.api.bsky.app` | None | Profile, posts |
| Constellation | `https://constellation.microcosm.blue` | None | Firehose-indexed interaction counts |

## Why this matters for OPE

AT Protocol gives every user a decentralized identifier (`did:plc:...`) that is:

- **Portable** — not locked to any single platform
- **Cryptographically verifiable** — tied to signing keys the user controls
- **Already deployed** — millions of Bluesky users have one

This maps perfectly to OPE's `publisherId` field. A publisher who uses Bluesky
already has everything they need to issue OPE grant tokens — no separate
identity registration required.
