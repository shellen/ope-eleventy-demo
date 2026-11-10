// ABOUTME: Eleventy plugin for OPE v0.2: generates OAuth Protected Resource metadata and feed Offers.
// ABOUTME: Spec: https://feedspec.org/ope/spec/0.2/ (discovery §7.1, Offers §6.2, Feeds profile).

const fs = require("node:fs");
const path = require("node:path");

const OPE_VERSION = "0.2";
const FULL_DIR = "/_ope"; // rendered here during the build, then moved out of the site

// ── Metadata builders (spec §7.1) ───────────────────────────────────
// Exported so servers and tests build the same documents the site publishes.

// Fill in defaults an Offer may leave out: the publisher's Terms, and an
// absolute purchase_url (front matter can only write a site-relative path).
function withTerms(config, offers) {
  return offers.map((o) => ({
    ...o,
    ...(o.purchase_url ? { purchase_url: new URL(o.purchase_url, config.siteUrl + "/").href } : {}),
    terms: o.terms || { url: config.terms.url },
  }));
}

function baseMetadata(config, resource, offers) {
  return {
    resource,
    resource_name: config.publisherName,
    resource_tos_uri: config.terms.url,
    authorization_servers: config.licenseServers,
    bearer_methods_supported: ["header"],
    dpop_signing_alg_values_supported: ["ES256"],
    ope: {
      version: OPE_VERSION,
      publisher: config.publisher,
      offers: withTerms(config, offers),
      ...(config.clientPolicy ? { client_policy: config.clientPolicy } : {}),
    },
  };
}

// Scope metadata: one document covering every Asset under the scope (§5.6).
function scopeMetadata(config, scopeEntry) {
  return baseMetadata(config, scopeEntry.scope, scopeEntry.offers);
}

// The scope (§5.5) containing an Asset URL: the longest matching prefix.
function scopeFor(config, assetUrl) {
  return config.scopes
    .filter((s) => assetUrl.startsWith(s.scope))
    .sort((a, b) => b.scope.length - a.scope.length)[0];
}

// Offers for one item: its own, added to those of its scope.
function itemOffers(config, assetUrl, extraOffers = []) {
  const scope = scopeFor(config, assetUrl);
  return [...(scope ? scope.offers : []), ...extraOffers];
}

// Per-URL metadata, for an item whose Offers differ from its scope's.
function itemMetadata(config, assetUrl, extraOffers = []) {
  return baseMetadata(config, assetUrl, itemOffers(config, assetUrl, extraOffers));
}

// RFC 9728 §3.1: insert the well-known segment between host and path.
function metadataPath(identifier) {
  const { pathname } = new URL(identifier);
  return "/.well-known/oauth-protected-resource" + (pathname === "/" ? "" : pathname);
}

// ── Plugin ──────────────────────────────────────────────────────────

module.exports = function opePlugin(eleventyConfig, config) {
  if (!config || !config.siteUrl || !config.scopes || !config.licenseServers) {
    throw new Error("eleventy-plugin-ope: siteUrl, licenseServers, and scopes are required");
  }

  eleventyConfig.addGlobalData("ope", { ...config, version: OPE_VERSION });

  const absolute = (url) => config.siteUrl + url;

  // Collections: gated posts, and posts with Offers of their own.
  eleventyConfig.addCollection("opeGated", (api) =>
    api.getAll().filter((item) => item.data.ope_gated));
  eleventyConfig.addCollection("opeItemOffers", (api) =>
    api.getAll().filter((item) => item.data.ope_gated && item.data.ope_offers));

  // Filters used by templates.
  eleventyConfig.addFilter("opeJson", (value) => JSON.stringify(value, null, 2));
  eleventyConfig.addFilter("opeAbsolute", absolute);
  eleventyConfig.addFilter("opeItemOffers", (post) =>
    withTerms(config, itemOffers(config, absolute(post.url), post.data.ope_offers || [])));
  eleventyConfig.addFilter("opePreview", (content, maxChars = 280) => {
    if (!content) return "";
    const stripped = content.replace(/<[^>]+>/g, "");
    if (stripped.length <= maxChars) return stripped;
    return stripped.substring(0, maxChars).replace(/\s+\S*$/, "") + "…";
  });
  eleventyConfig.addFilter("opeWordCount", (content) =>
    content ? content.replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean).length : 0);
  eleventyConfig.addFilter("opeReadTime", (content) =>
    content ? Math.ceil(content.replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean).length / 250) : 0);

  // Scope metadata documents, one per scope.
  config.scopes.forEach((scopeEntry, i) => {
    eleventyConfig.addTemplate(
      `ope-scope-metadata-${i}.11ty.js`,
      { render: () => JSON.stringify(scopeMetadata(config, scopeEntry), null, 2) },
      { permalink: metadataPath(scopeEntry.scope) + "/index.html", eleventyExcludeFromCollections: true },
    );
  });

  // Per-URL metadata for items with Offers of their own. Post URLs end in "/",
  // so each document is a folder index.
  eleventyConfig.addTemplate(
    "ope-item-metadata.11ty.js",
    {
      data: {
        pagination: { data: "collections.opeItemOffers", size: 1, alias: "post" },
        permalink: (data) => metadataPath(absolute(data.post.url)) + "index.html",
        eleventyExcludeFromCollections: true,
      },
      render: (data) =>
        JSON.stringify(itemMetadata(config, absolute(data.post.url), data.post.data.ope_offers), null, 2),
    },
  );

  // Full versions of gated posts, rendered with the site's own layout. ope_unlocked
  // tells the layout to show the whole post; ope_post is the original post.
  eleventyConfig.addTemplate(
    "ope-full.11ty.js",
    {
      data: {
        layout: config.fullLayout || "post.njk",
        pagination: { data: "collections.opeGated", size: 1, alias: "ope_post" },
        permalink: (data) => `${FULL_DIR}${data.ope_post.url}index.html`,
        eleventyExcludeFromCollections: true,
        ope_unlocked: true,
        eleventyComputed: { title: (data) => data.ope_post.data.title },
      },
      render: (data) => data.ope_post.content,
    },
  );

  // Index of gated posts, gathered with the full and preview pages after the build.
  eleventyConfig.addTemplate(
    "ope-gated-index.11ty.js",
    {
      render: (data) => JSON.stringify(
        Object.fromEntries((data.collections.opeGated || []).map((post) => [post.url, {
          title: post.data.title,
          // Posts with Offers of their own have per-URL metadata; challenges point to it.
          ...(post.data.ope_offers ? { metadata: metadataPath(absolute(post.url)) } : {}),
        }]))),
    },
    { permalink: `${FULL_DIR}/gated.json`, eleventyExcludeFromCollections: true },
  );

  // Netlify: send each gated post's URL to the OPE function. Off unless asked for,
  // since a site may already have its own _redirects.
  if (config.netlify) {
    const fn = config.netlify.functionName || "ope";
    eleventyConfig.addTemplate(
      "ope-redirects.11ty.js",
      {
        render: (data) => (data.collections.opeGated || [])
          .map((post) => `${post.url}  /.netlify/functions/${fn}  200!`).join("\n") + "\n",
      },
      { permalink: "/_redirects", eleventyExcludeFromCollections: true },
    );
  }

  // After the build, move the full posts out of the published site into one
  // content file, with each post's preview. Nothing secret is left for a static
  // host to serve, however a request path is spelled.
  eleventyConfig.on("eleventy.after", ({ dir, results }) => {
    const byUrl = new Map(results.map((r) => [r.url, r]));
    const indexResult = byUrl.get(`${FULL_DIR}/gated.json`);
    if (!indexResult) return; // an incremental build that didn't touch gated posts
    const index = JSON.parse(indexResult.content);
    const posts = {};
    for (const [url, entry] of Object.entries(index)) {
      const full = byUrl.get(`${FULL_DIR}${url}`);
      const preview = byUrl.get(url);
      if (!full || !preview) throw new Error(`eleventy-plugin-ope: missing rendered page for ${url}`);
      posts[url] = { ...entry, full: full.content, preview: preview.content };
    }
    const file = path.resolve(config.contentFile || process.env.OPE_CONTENT_FILE || ".ope/content.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The site's public OPE settings travel with the posts, so a host's runtime
    // (the Cloudflare Worker) can serve them without its own configuration.
    const { siteUrl, publisherName, publisher, licenseServers, terms, scopes, clientPolicy } = config;
    const settings = { siteUrl, publisherName, publisher, licenseServers, terms, scopes, clientPolicy };
    fs.writeFileSync(file, JSON.stringify({ version: OPE_VERSION, siteUrl, config: settings, posts }));
    fs.rmSync(path.join(dir.output, FULL_DIR), { recursive: true, force: true });
  });
};

module.exports.OPE_VERSION = OPE_VERSION;
module.exports.scopeMetadata = scopeMetadata;
module.exports.itemMetadata = itemMetadata;
module.exports.scopeFor = scopeFor;
module.exports.metadataPath = metadataPath;
