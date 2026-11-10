// ABOUTME: Test harness: starts the Cloudflare Worker under wrangler dev (Cloudflare's local runtime),
// ABOUTME: passing this process's OPE_* environment as Worker variables, with fresh Durable Object storage.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.env.PORT || "4000";
const vars = Object.entries(process.env)
  .filter(([k]) => k.startsWith("OPE_"))
  .flatMap(([k, v]) => ["--var", `${k}:${v}`]);
// The issuer is the Worker's own address (http://localhost:PORT here) unless OPE_ISSUER is set.

const child = spawn("npx", ["wrangler", "dev", "--port", port, "--persist-to", mkdtempSync(join(tmpdir(), "ope-cf-")), ...vars], {
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  stdio: ["ignore", "ignore", "inherit"],
  detached: true, // its own process group, so stopping it also stops wrangler's runtime
});
const stop = () => {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => process.exit(code ?? 0));
