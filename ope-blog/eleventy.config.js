export default function (eleventyConfig) {
  const siteUrl = process.env.URL || "https://ope-demo.netlify.app";
  const publisherName = "OPE Demo Blog";
  const publisherId = "did:web:ope-demo.netlify.app";
  const defaultTtl = 3600;
  const plans = [
    { id: "monthly", name: "Monthly", currency: "USD", amount: 500 },
    { id: "annual", name: "Annual", currency: "USD", amount: 4000 },
  ];
  const grantsSupported = ["subscription", "gift", "per_item", "metered"];

  // ── OPE global data ──
  eleventyConfig.addGlobalData("ope", {
    siteUrl,
    publisherName,
    publisherId,
    defaultTtl,
    subscribeUrl: "/subscribe/",
    plans,
    grantsSupported,
  });

  // ── OPE filters ──
  eleventyConfig.addFilter("opePreview", function (content, maxChars) {
    if (maxChars === undefined) maxChars = 280;
    if (!content) return "";
    const stripped = content.replace(/<[^>]+>/g, "");
    if (stripped.length <= maxChars) return stripped;
    return stripped.substring(0, maxChars).replace(/\s+\S*$/, "") + "\u2026";
  });

  eleventyConfig.addFilter("opeWordCount", function (content) {
    if (!content) return 0;
    return content.replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean).length;
  });

  eleventyConfig.addFilter("opeReadTime", function (content) {
    if (!content) return 0;
    const words = content.replace(/<[^>]+>/g, "").split(/\s+/).filter(Boolean).length;
    return Math.ceil(words / 250);
  });

  eleventyConfig.addFilter("jsonEscape", function (str) {
    if (!str) return "";
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
  });

  eleventyConfig.configureErrorReporting({ allowMissingExtensions: true });

  return {
    dir: { input: "src", output: "_site" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
