// ABOUTME: Test harness: serves the Netlify Function over HTTP, with Netlify's local Blobs server.
// ABOUTME: Lets the end-to-end suite run against the hosted code path (state saved after every request).

import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobsServer } from "@netlify/blobs/server";
import { getStore } from "@netlify/blobs";
import { createHandler } from "../netlify/functions/ls.mjs";

const PORT = Number(process.env.PORT || 4000);
const blobs = new BlobsServer({ directory: mkdtempSync(join(tmpdir(), "ope-blobs-")), token: "test", port: 0 });
const { port: blobsPort } = await blobs.start();
const handler = createHandler(() => getStore({
  name: "ope-license-server", siteID: "test-site", token: "test", apiURL: `http://localhost:${blobsPort}`,
}));

// Turn each HTTP request into the Lambda-style event Netlify sends, through the rewrite.
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const response = await handler({
    httpMethod: req.method,
    path: "/.netlify/functions/ls" + url.pathname,
    rawUrl: url.href,
    headers: req.headers,
    multiValueHeaders: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, [].concat(v)])),
    queryStringParameters: Object.fromEntries(url.searchParams),
    multiValueQueryStringParameters: Object.fromEntries([...url.searchParams.keys()].map((k) => [k, url.searchParams.getAll(k)])),
    body: Buffer.concat(chunks).toString("base64"),
    isBase64Encoded: true,
  }, {});
  const headers = { ...response.headers };
  for (const [k, v] of Object.entries(response.multiValueHeaders || {})) headers[k] = v;
  res.writeHead(response.statusCode, headers);
  res.end(response.isBase64Encoded ? Buffer.from(response.body, "base64") : response.body);
}).listen(PORT);
