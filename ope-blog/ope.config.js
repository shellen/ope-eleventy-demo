// ABOUTME: The publisher's OPE settings, shared by the Eleventy build and the server.
// ABOUTME: One source of truth for the scope, Offers, and which License Servers may issue.

// On Netlify, URL is the site's primary address; OPE_SITE_URL overrides it.
const siteUrl = (process.env.OPE_SITE_URL || process.env.URL || "http://localhost:8080").replace(/\/$/, "");
const licenseServer = (process.env.OPE_LICENSE_SERVER || "http://localhost:4000").replace(/\/$/, "");

export default {
  siteUrl,
  publisherName: "OPE Demo Blog",
  // The layout the plugin renders full posts with; it gets ope_unlocked: true.
  fullLayout: "post.njk",
  // On Netlify, write _redirects sending each gated post to functions/ope.mjs.
  // (Netlify sets NETLIFY during its builds.)
  netlify: process.env.NETLIFY ? { functionName: "ope" } : undefined,
  // Publisher identifier (spec §5.8): this site's own origin.
  publisher: `${siteUrl}/`,
  // License Servers allowed to issue for this blog (spec §7.1, authorization_servers).
  licenseServers: [licenseServer],
  // The publisher's Terms (spec §6.1). Served as a static page so its digest is stable.
  terms: { url: `${siteUrl}/terms/`, type: "text/html" },
  // One scope (spec §5.5) covers every post. Each post's URL is its Asset identifier.
  scopes: [
    {
      scope: `${siteUrl}/posts/`,
      offers: [
        {
          id: "monthly",
          name: "OPE Demo Blog, monthly",
          payment: { type: "subscription", amount: "5.00", currency: "USD", period: "P1M" },
          purchase_url: `${siteUrl}/subscribe/`,
          entitlement_types: ["access"],
          preview_note: "Every subscriber-only post, in any OPE app.",
        },
        {
          id: "annual",
          name: "OPE Demo Blog, annual",
          payment: { type: "subscription", amount: "50.00", currency: "USD", period: "P1Y" },
          purchase_url: `${siteUrl}/subscribe/`,
          entitlement_types: ["access"],
        },
      ],
    },
  ],
};
