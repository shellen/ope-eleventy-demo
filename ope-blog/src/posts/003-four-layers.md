---
title: The Four Layers of Publishing
date: 2026-03-22
---

If you look at any modern publishing platform — Substack, Ghost, Medium, Patreon — they all bundle four distinct layers into one product:

The content layer is what you write. Words, images, audio, video. This is the thing that matters and the thing that should be most portable. Yet on most platforms, exporting your full archive with formatting intact is somewhere between difficult and impossible.

The distribution layer is how people find your work. Feeds, email delivery, social sharing, search indexing. RSS and Atom solved this decades ago for the open web. Newsletters partially solved it for email. But platform-specific distribution (Substack's recommendation engine, Medium's algorithm) creates lock-in by design.

The entitlement layer is how you know someone is allowed to read something. Today this is deeply fused with payment processing — Stripe handles both "did they pay?" and "are they allowed in?" through the same subscription object. Separating these concerns means your entitlement can outlive any specific payment relationship.

The payment layer is how money moves. Credit cards, crypto, wire transfers, gift codes, institutional licenses. This is the layer with the most innovation happening right now — x402, Lightning, stablecoins — and the layer that benefits most from being decoupled from everything else.

When these layers are separate, interesting things happen. A reader app can show you gated content from twenty publishers without any of them sharing a payment processor. A university library can provide institutional access without each publisher implementing SAML. A friend can gift you a single article without the publisher building a gift-link feature.

Separation of concerns isn't just good engineering. It's what makes an ecosystem possible.
