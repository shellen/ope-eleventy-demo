// ABOUTME: Express middleware serving gated posts through the OPE checks.
// ABOUTME: Usage: app.use(opeMiddleware(config)); then express.static for everything else.

import { createHandler } from "./serve.mjs";

export function opeMiddleware(config, options = {}) {
  const { handle } = createHandler(config, options);
  return async (req, res, next) => {
    try {
      // req.originalUrl is the path as sent, before Express decodes anything.
      const out = await handle({ method: req.method, path: req.originalUrl, headers: req.headers });
      if (!out) return next();
      for (const [name, value] of Object.entries(out.headers)) res.set(name, value);
      res.status(out.status).type(out.type).send(out.body);
    } catch (err) {
      next(err);
    }
  };
}
