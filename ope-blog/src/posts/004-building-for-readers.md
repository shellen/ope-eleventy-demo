---
title: Building for Readers, Not Platforms
date: 2026-03-25
ope_gated: true
ope_content_id: building-for-readers
ope_resource_type: article
ope_level: subscriber
ope_cta: "Subscribe for $5/month, or buy this article for $2"
ope_grants:
  - subscription
  - gift
  - per_item
  - trial
ope_per_item_price:
  currency: USD
  amount: 200
---

The most important person in the publishing ecosystem is the one who reads. Not the writer, not the platform, not the payment processor — the reader. And yet readers have the least power in the current system.

When you subscribe to a newsletter on Substack, you're making a commitment to a platform as much as to a writer. Your reading history, your subscription list, your payment method — all of it lives inside Substack's database. If you want to switch to a different reading experience, you can't bring your subscriptions with you. If the writer moves to Ghost, you might not even know.

This isn't a new problem. We solved it once before with RSS readers. Google Reader, NetNewsWire, Feedly — these tools let you subscribe to anything, read it anywhere, and own your subscription list as a simple OPML file. The problem was that RSS didn't support paid content. There was no standard way to say "this feed item requires a subscription" and no portable way to prove you had one.

OPE fills exactly this gap. A reader application that supports OPE can do something no current platform allows: show you a unified view of all your subscriptions — free and paid — across every publisher, with a single interface for managing access. When you open your reader after a week offline, it batch-syncs entitled content from every publisher in parallel, each using its own grant token.

The technical details matter because they create the user experience. Short-lived tokens mean your reader silently refreshes access in the background — you never see an "access expired" error. Content metadata means your reader shows you the word count, read time, and a meaningful preview before you decide to subscribe. Batch retrieval means syncing twenty publishers doesn't take twenty times as long.

But the most important detail is what OPE doesn't do: it doesn't require you to use a specific reader. Any app that implements the spec can participate. Your subscription to a publisher works in Pull Read, in NetNewsWire, in a browser extension, in a command-line tool. The entitlement is yours, not the app's.

This is what building for readers means: giving them the ability to choose their tools without giving up access to the content they've paid for. It sounds obvious, but it requires a level of interoperability that the current newsletter ecosystem has deliberately avoided.
