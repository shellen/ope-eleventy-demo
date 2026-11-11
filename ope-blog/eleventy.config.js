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
  });

  return {
    dir: { input: "src", output: "_site" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
