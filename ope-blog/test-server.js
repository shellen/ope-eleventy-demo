// ABOUTME: Tests for the publisher's local Express server.
// ABOUTME: Validates static file serving and JWT-gated content API.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

const PORT = 8181;
const SECRET = "test-secret";
const BASE = `http://localhost:${PORT}`;

let server;

before(async () => {
  process.env.PORT = String(PORT);
  process.env.OPE_JWT_SECRET = SECRET;
  const mod = await import("./server.js");
  server = mod.server;
  // Give the server a moment to start
  await new Promise((r) => setTimeout(r, 200));
});

after(() => {
  if (server) server.close();
});

function makeToken(overrides = {}) {
  const payload = {
    iss: "http://localhost:4000",
    sub: "test-user",
    scope: ["content:read"],
    grant_type: "subscription",
    jti: "test_grant_001",
    ...overrides,
  };
  return jwt.sign(payload, SECRET, { algorithm: "HS256", expiresIn: "1h" });
}

describe("static files", () => {
  it("serves index.html at /", async () => {
    const res = await fetch(BASE + "/");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("<!"), "should return HTML");
  });

  it("serves feed.json", async () => {
    const res = await fetch(BASE + "/feed.json");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.version, "https://jsonfeed.org/version/1.1");
  });

  it("serves .well-known/ope discovery document", async () => {
    const res = await fetch(BASE + "/.well-known/ope/");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.version, "0.1");
  });
});

describe("GET /api/content/:id", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await fetch(BASE + "/api/content/protocol-economics");
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, "invalid_token");
  });

  it("returns 401 with invalid token", async () => {
    const res = await fetch(BASE + "/api/content/protocol-economics", {
      headers: { Authorization: "Bearer garbage" },
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, "invalid_token");
  });

  it("returns content with valid token", async () => {
    const token = makeToken();
    const res = await fetch(BASE + "/api/content/protocol-economics", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.id, "protocol-economics");
    assert.ok(data.content_html, "should include full HTML content");
  });

  it("returns 404 for nonexistent content", async () => {
    const token = makeToken();
    const res = await fetch(BASE + "/api/content/does-not-exist", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.error, "not_found");
  });

  it("returns 403 when scope is missing content:read", async () => {
    const token = makeToken({ scope: ["other:thing"] });
    const res = await fetch(BASE + "/api/content/protocol-economics", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.error, "not_entitled");
  });

  it("returns 403 for per_item grant without matching content_id", async () => {
    const token = makeToken({
      grant_type: "per_item",
      content_ids: ["some-other-content"],
    });
    const res = await fetch(BASE + "/api/content/protocol-economics", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.error, "not_entitled");
  });

  it("returns content for per_item grant with matching content_id", async () => {
    const token = makeToken({
      grant_type: "per_item",
      content_ids: ["protocol-economics"],
    });
    const res = await fetch(BASE + "/api/content/protocol-economics", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.id, "protocol-economics");
  });
});
