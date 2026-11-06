// ABOUTME: Eleventy configuration for the OPE demo blog.
// ABOUTME: Registers the OPE plugin with the shared settings in ope.config.js.

import opePlugin from "eleventy-plugin-ope";
import opeConfig from "./ope.config.js";

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(opePlugin, opeConfig);
  eleventyConfig.configureErrorReporting({ allowMissingExtensions: true });

  return {
    dir: { input: "src", output: "_site" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
