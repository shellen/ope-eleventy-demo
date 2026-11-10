// ABOUTME: Cloudflare Worker for the OPE demo blog: gated posts through the plugin's checks,
// ABOUTME: everything else from the Eleventy build's static files (the ASSETS binding).
import { cloudflareHandler } from "eleventy-plugin-ope/cloudflare";
import content from "../.ope/content.json" with { type: "json" };

export default cloudflareHandler(content);
