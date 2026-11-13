// ABOUTME: Eleventy configuration for the OPE demo blog.
// ABOUTME: Registers the OPE plugin with the shared settings in ope.config.js.

import opePlugin from "eleventy-plugin-ope";
import opeConfig from "./ope.config.js";

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(opePlugin, opeConfig);
  eleventyConfig.configureErrorReporting({ allowMissingExtensions: true });

  // The browser reader, served from this site at /reader/ (same origin: no proxy needed).
  eleventyConfig.addPassthroughCopy({
    "../ope-reader/index.html": "reader/index.html",
    "../ope-reader/ope-client.js": "reader/ope-client.js",
    "../ope-reader/callback.html": "reader/callback/index.html",
    // OPE and atproto spaces explainer, served at /atproto/.
    "../atproto-example/index.html": "atproto/index.html",
    // The multi-user space app, at /space-app/. Its module keeps the repo's layout, so
    // the same relative imports work here and in Node; src/ope-client-copy.11ty.js
    // serves the reader's client at /ope-reader/ope-client.js for it.
    "../atproto-example/space-app/index.html": "space-app/index.html",
    "../atproto-example/space-app/callback.html": "space-app/callback/index.html",
    "../atproto-example/space-app.mjs": "atproto-example/space-app.mjs",
  });

  return {
    dir: { input: "src", output: "_site" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
