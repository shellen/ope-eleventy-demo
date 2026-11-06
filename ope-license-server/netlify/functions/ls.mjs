// ABOUTME: Runs the OPE License Server as a Netlify Function, with its state in Netlify Blobs.
// ABOUTME: netlify.toml routes every path here; app.js is the same app server.js runs locally.

import serverless from "serverless-http";
import { connectLambda, getStore } from "@netlify/blobs";
import { app, exportState, importState } from "../../app.js";

const run = serverless(app);
const STATE_KEY = "state";
const FUNCTION_PATH = /^\/\.netlify\/functions\/ls(?=\/|$)/;

// Each request: load the saved state, handle the request, save the state if it
// changed. The save only succeeds if nobody else saved in between; if someone
// did, the request runs again on the fresher state. The response goes out only
// after its state is saved, so a refresh-token rotation is never lost.
export function createHandler(openStore) {
  return async (event, context) => {
    const store = openStore(event);
    // Requests arrive through a rewrite; route on the path the client asked for.
    event = { ...event, path: (event.path || "/").replace(FUNCTION_PATH, "") || "/" };
    for (let attempt = 1; ; attempt++) {
      const saved = await store.getWithMetadata(STATE_KEY, { type: "json" });
      importState(saved?.data);
      const before = JSON.stringify(exportState());
      const response = await run(event, context);
      const after = exportState();
      if (JSON.stringify(after) === before) return response;
      const write = await store.setJSON(STATE_KEY, after, saved ? { onlyIfMatch: saved.etag } : { onlyIfNew: true });
      if (write.modified) return response;
      if (attempt === 3) return { statusCode: 503, headers: { "Retry-After": "1" }, body: "Busy, please retry" };
    }
  };
}

export const handler = createHandler((event) => {
  connectLambda(event);
  return getStore({ name: "ope-license-server", consistency: "strong" });
});
