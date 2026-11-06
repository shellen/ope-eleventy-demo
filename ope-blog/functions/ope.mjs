// ABOUTME: Netlify Function for gated posts. The plugin's _redirects route each gated post here.
import { netlifyHandler } from "eleventy-plugin-ope/netlify";
import config from "../ope.config.js";
import content from "../.ope/content.json" with { type: "json" };

export const handler = netlifyHandler(config, content);
