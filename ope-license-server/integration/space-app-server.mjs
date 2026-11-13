// ABOUTME: Runs the space app page against a real atproto space, locally: Bluesky's spaces-alpha
// ABOUTME: PDS (@atproto/dev-env), the License Server as the space's managing app, and a publisher.

// npm run space-app   (in ope-license-server/integration), then open the URL it prints.
//
// What it starts:
//   - a spaces-alpha PDS with a publisher's managed space holding three posts, and three
//     readers' atproto accounts (Ada, Bobby, Carol);
//   - the License Server on :4000, managing that space, with each reader's atproto
//     account linked to the License Server account of the same name;
//   - a publisher on :8090 serving the OPE metadata for the Asset the space stands for,
//     its Terms, and the space app page, with a config.json naming the real space.
//
// The page is the same one the hosted blog serves at /space-app/; here it syncs the real
// space instead of the stand-in. Sign in at the License Server as Ada, Bobby, or Carol
// (the names the accounts are linked under), so a subscription admits that reader's sync.

import { TestNetworkNoAppView } from "@atproto/dev-env";
import express from "express";
import { fileURLToPath } from "node:url";

const LS_PORT = 4000;
const PUB_PORT = 8090;
const PUB = `http://localhost:${PUB_PORT}`;
const ASSET = `${PUB}/posts/`;
const ROOT = fileURLToPath(new URL("../../", import.meta.url)); // the repo
const SPACE_TYPE = "com.example.group";
const POSTS = "com.example.post";
const READERS = ["Ada", "Bobby", "Carol"];

const network = await TestNetworkNoAppView.create({});
const pds = network.pds;
async function xrpc(method, { body, token }) {
  const res = await fetch(`${pds.url}/xrpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
  return data;
}
const createAccount = (handle) => xrpc("com.atproto.server.createAccount", { body: { handle: `${handle}.test`, email: `${handle}@test.com`, password: `${handle}-pass` } });

const publisher = await createAccount("publisher");
const readers = {};
for (const name of READERS) readers[name] = await createAccount(`${name.toLowerCase()}reader`);
const space = `at://${publisher.did}/space/${SPACE_TYPE}/subscribers`;

// The License Server, managing the space.
process.env.OPE_ISSUER = `http://localhost:${LS_PORT}`;
process.env.PORT = String(LS_PORT);
process.env.OPE_PROTECTED_RESOURCES = ASSET;
process.env.OPE_PLC_URL = network.plc.url;
process.env.OPE_MANAGED_SPACES = JSON.stringify([{ space, resource: ASSET }]);
const ls = await import("../app.js");
ls.importState({ maps: { atprotoLinks: READERS.map((name) => [name, { did: readers[name].did, handle: readers[name].handle }]) } });
await new Promise((resolve) => ls.app.listen(LS_PORT, resolve));

await xrpc("com.atproto.space.createSpace", {
  token: publisher.accessJwt,
  body: { spaceType: SPACE_TYPE, skey: "subscribers", policy: { $type: "com.atproto.managedspace.policy", managingApp: ls.spaceManager.managingApp } },
});
const posts = [
  ["Subscribers only: why spaces need an entitlement layer", "A space can ask a managing app who may read. OPE answers from the reader's subscription, wherever they bought it."],
  ["Subscribers only: one subscription, every app", "The same subscription unlocks the blog, the reader app, and this space app, each checking it its own way."],
  ["Subscribers only: what the app owes its users", "The space admits the app. Deciding which of its users see the posts is the app's job, and an OPE token per user is how it decides."],
];
for (const [title, text] of posts) {
  await xrpc("com.atproto.space.createRecord", {
    token: publisher.accessJwt,
    body: { space, repo: publisher.did, collection: POSTS, validate: false, record: { $type: POSTS, title, text, createdAt: new Date().toISOString() } },
  });
}

// The publisher: OPE metadata for the Asset (RFC 9728), Terms, and the page.
const pub = express();
pub.get("/.well-known/oauth-protected-resource/posts/", (_req, res) => res.json({
  resource: ASSET,
  authorization_servers: [`http://localhost:${LS_PORT}`],
  ope: {
    publisher: `${PUB}/`,
    offers: [{ id: "monthly", name: "Subscribers, monthly", payment: { type: "subscription", amount: "5.00", currency: "USD", period: "P1M" }, terms: { url: `${PUB}/terms/` }, entitlement_types: ["access"] }],
  },
}));
pub.get("/terms/", (_req, res) => res.type("text/plain").send("Personal use. Demo terms."));
pub.get("/space-app/config.json", (_req, res) => res.json({
  asset: ASSET,
  source: { type: "atproto", space, spaceHost: pds.url, collection: POSTS },
  users: READERS,
  // Local demo only: each reader's atproto session, so the page can sync as them.
  sessions: Object.fromEntries(READERS.map((name) => [name, { pds: pds.url, accessJwt: readers[name].accessJwt }])),
  note: "Sign in at the License Server as Ada, Bobby, or Carol: those accounts are linked to the readers' atproto accounts.",
}));
pub.get("/space-app/", (_req, res) => res.sendFile(`${ROOT}atproto-example/space-app/index.html`));
pub.get("/space-app/callback/", (_req, res) => res.sendFile(`${ROOT}atproto-example/space-app/callback.html`));
pub.get("/atproto-example/space-app.mjs", (_req, res) => res.type("text/javascript").sendFile(`${ROOT}atproto-example/space-app.mjs`));
pub.get("/ope-reader/ope-client.js", (_req, res) => res.type("text/javascript").sendFile(`${ROOT}ope-reader/ope-client.js`));
pub.get("/", (_req, res) => res.redirect("/space-app/"));
await new Promise((resolve) => pub.listen(PUB_PORT, resolve));

console.log(`
  Space app, against a real atproto space on Bluesky's spaces-alpha PDS:

    ${PUB}/space-app/

  Space:           ${space}
  PDS:             ${pds.url}
  License Server:  http://localhost:${LS_PORT}  (sign in as Ada, Bobby, or Carol)

  Try: connect Ada (choose the Offer), sync for Ada, then look at Bobby.
  Ctrl-C to stop.
`);

process.on("SIGINT", async () => { await network.close(); process.exit(0); });
