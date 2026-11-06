// ABOUTME: Runs the OPE License Server locally. The app itself is app.js.
// ABOUTME: State lives in memory, so a restart starts over.

import { app, ISSUER, PORT, PROTECTED_RESOURCES, RS_CREDENTIALS } from "./app.js";

const server = app.listen(PORT, () => {
  console.log(`\n  OPE License Server running on ${ISSUER}`);
  console.log(`  Metadata:   ${ISSUER}/.well-known/oauth-authorization-server`);
  console.log(`  Issues for: ${PROTECTED_RESOURCES.join(", ")}`);
  console.log(`  Introspection credentials: ${RS_CREDENTIALS.size ? [...RS_CREDENTIALS.keys()].join(", ") : "none"}\n`);
});

export { server, app };
