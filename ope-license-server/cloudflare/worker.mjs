// ABOUTME: Runs the OPE License Server on Cloudflare Workers, with its state in a Durable Object.
// ABOUTME: Every request goes to one Durable Object, which runs the same Express app as server.js.

import { DurableObject } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";

// Cloudflare's Node.js compatibility: an http server "listening" on a port that
// is only a routing key, so httpServerHandler can hand it Requests.
const PORT = 8080;
const express = httpServerHandler({ port: PORT });
let lsApp; // app.js, loaded on the first request (see below)

// One instance holds all the state, in memory, as the local server does. It
// handles requests one at a time between awaits, again like a single Node
// process. After any request that changes the state, the state is written to
// the object's own SQLite storage, so it survives restarts and moves.
export class LicenseServerState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      // The signing key: OPE_LS_KEY if set, otherwise one this object generated
      // on its first run and keeps in its own storage. Nobody handles a private key.
      if (!process.env.OPE_LS_KEY) {
        let key = this.read("key");
        if (!key) {
          const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
          const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
          key = JSON.stringify({ kty, crv, x, y, d });
          this.write("key", key);
        }
        process.env.OPE_LS_KEY = key;
      }
    });
  }

  read(k) {
    return this.ctx.storage.sql.exec("SELECT v FROM state WHERE k = ?", k).toArray()[0]?.v;
  }

  write(k, v) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO state (k, v) VALUES (?, ?)", k, v);
  }

  async fetch(request) {
    await this.ready;
    if (!lsApp) {
      // The issuer is this Worker's own address unless OPE_ISSUER says otherwise.
      // app.js reads its settings when it loads, so it loads after they're set.
      process.env.OPE_ISSUER ||= new URL(request.url).origin;
      lsApp = await import("../app.js");
      lsApp.app.listen(PORT);
      const saved = this.read("state");
      lsApp.importState(saved ? JSON.parse(saved) : null);
      this.saved = JSON.stringify(lsApp.exportState());
    }
    const response = await express.fetch(request, this.env, this.ctx);
    const current = JSON.stringify(lsApp.exportState());
    if (current !== this.saved) {
      this.write("state", current);
      this.saved = current;
    }
    return response;
  }
}

export default {
  fetch(request, env) {
    return env.LICENSE_SERVER.get(env.LICENSE_SERVER.idFromName("main")).fetch(request);
  },
};
