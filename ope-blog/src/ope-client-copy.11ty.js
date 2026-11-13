// ABOUTME: Serves the reader's OPE client at /ope-reader/ope-client.js, where the space app's
// ABOUTME: module imports it from (../ope-reader/ope-client.js, as in the repo).

import { readFileSync } from "node:fs";

export const data = {
  permalink: "/ope-reader/ope-client.js",
  eleventyExcludeFromCollections: true,
};

export function render() {
  return readFileSync(new URL("../../ope-reader/ope-client.js", import.meta.url), "utf8");
}
