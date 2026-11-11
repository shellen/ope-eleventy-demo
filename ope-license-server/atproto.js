// ABOUTME: Prototype of OPE's future ATProto profile: the License Server as an atproto space's
// ABOUTME: "managing app", answering com.atproto.managedspace.checkAccess from OPE Entitlements.

// atproto spaces (proposal 0016) are alpha. A space under the `managedspace` policy
// asks its managing app, for each reader, whether they may read or write. Here the
// answer comes from the reader's OPE Entitlement. See the spec's Profile E notes.

import { verifySignature } from "@atproto/crypto";

export const CHECK_ACCESS = "com.atproto.managedspace.checkAccess";
// The proposal text calls it checkUserAccess; answer both while the alpha settles.
export const CHECK_USER_ACCESS = "com.atproto.managedspace.checkUserAccess";
export const SERVICE_ID = "ope_space_manager";

// ── DID resolution: a DID's atproto signing key, as a did:key ──
// did:plc from plc.directory, did:web from /.well-known/did.json. Cached for an hour.
const keyCache = new Map(); // did → { key, at }
export async function resolveAtprotoKey(did, forceRefresh = false) {
  const hit = keyCache.get(did);
  if (hit && !forceRefresh && Date.now() - hit.at < 3600 * 1000) return hit.key;
  let url;
  if (did.startsWith("did:plc:")) url = `https://plc.directory/${did}`;
  else if (did.startsWith("did:web:")) url = `https://${decodeURIComponent(did.slice(8))}/.well-known/did.json`;
  else throw new Error(`unsupported DID method: ${did}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not resolve ${did} (HTTP ${res.status})`);
  const doc = await res.json();
  const vm = (doc.verificationMethod || []).find((m) => m.id === `${did}#atproto` || m.id === "#atproto");
  if (!vm || vm.type !== "Multikey" || !vm.publicKeyMultibase) throw new Error(`${did} has no atproto Multikey`);
  const key = `did:key:${vm.publicKeyMultibase}`;
  keyCache.set(did, { key, at: Date.now() });
  return key;
}

// ── Inter-service auth (atproto "service auth" JWTs) ──
// Mirrors verifyJwt in @atproto/xrpc-server, without its server dependencies (which
// don't run on Cloudflare Workers): checks type, expiry, audience, method, issuer,
// and the signature against the issuer's key, retrying once with a fresh key in case
// the issuer rotated it.
const b64urlJson = (part) => JSON.parse(new TextDecoder().decode(b64urlBytes(part)));
const b64urlBytes = (part) => Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
export async function verifyServiceJwt(jwt, { aud, lxm, getKey }) {
  const parts = (jwt || "").split(".");
  if (parts.length !== 3) throw new Error("poorly formatted jwt");
  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    throw new Error("poorly formatted jwt");
  }
  if (["at+jwt", "refresh+jwt", "dpop+jwt"].includes(header.typ)) throw new Error(`invalid jwt type "${header.typ}"`);
  if (!(Date.now() / 1000 < payload.exp)) throw new Error("jwt expired");
  if (payload.aud !== aud) throw new Error("jwt audience does not match this service");
  if (payload.lxm !== lxm) throw new Error(`jwt lexicon method must be ${lxm}`);
  if (typeof payload.iss !== "string" || !/^did:[a-z]+:[^#]+(#.+)?$/.test(payload.iss)) throw new Error("jwt iss is not a DID");
  const msg = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = b64urlBytes(parts[2]);
  const check = (key) => verifySignature(key, msg, sig, { jwtAlg: header.alg, allowMalleableSig: true }).catch(() => false);
  const issDid = payload.iss.split("#")[0];
  const key = await getKey(issDid, false);
  if (await check(key)) return payload;
  const fresh = await getKey(issDid, true);
  if (fresh !== key && (await check(fresh))) return payload;
  throw new Error("jwt signature does not match its issuer");
}

// did:web for an issuer like https://ope-license-server.example.workers.dev
// (a port is percent-encoded, as did:web requires).
export function didWebFor(issuer) {
  const u = new URL(issuer);
  return "did:web:" + encodeURIComponent(u.host);
}

// "at://did:plc:abc/space/blog.example.post/main" → { authority, type, skey }
export function parseSpaceRef(ref) {
  const m = /^at:\/\/(did:[a-z]+:[^/]+)\/space\/([^/]+)\/([^/]+)$/.exec(ref || "");
  return m ? { authority: decodeURIComponent(m[1]), type: m[2], skey: m[3] } : null;
}

// options:
//   issuer: this License Server's issuer URL
//   spaces: [{ space: "<space-ref>", resource: "<OPE resource the space stands for>" }]
//   entitled(did, resource): true if the account linked to `did` holds an active
//     Entitlement covering `resource`
//   resolveKey(did, forceRefresh): the DID's atproto signing key, as a did:key
export function createSpaceManager({ issuer, spaces, entitled, resolveKey }) {
  const did = didWebFor(issuer);
  // resolveKey may return null to mean "use the default resolver" (DID documents over HTTPS).
  const getKey = async (d, force) => (resolveKey && (await resolveKey(d, force))) || resolveAtprotoKey(d, force);

  // The DID document that makes `${did}#${SERVICE_ID}` resolvable as a managing app.
  function didDocument() {
    return {
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: did,
      service: [{ id: `#${SERVICE_ID}`, type: "OpeSpaceManager", serviceEndpoint: issuer }],
    };
  }

  // Express handler for both method names.
  async function checkAccess(req, res) {
    const lxm = req.path.endsWith(CHECK_USER_ACCESS) ? CHECK_USER_ACCESS : CHECK_ACCESS;
    const space = String(req.query.space || "");
    const reader = String(req.query.repo || req.query.user || "");
    const ref = parseSpaceRef(space);
    const managed = spaces.find((s) => s.space === space);
    if (!ref || !reader.startsWith("did:")) {
      return res.status(400).json({ error: "InvalidRequest", message: "space (a space-ref) and repo (a DID) are required" });
    }

    // Service auth: a JWT from the space's authority, addressed to this service
    // and to this method (atproto inter-service auth).
    const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    let payload;
    try {
      payload = await verifyServiceJwt(jwt, { aud: did, lxm, getKey });
    } catch (e) {
      return res.status(401).json({ error: "AuthenticationRequired", message: e.message });
    }
    if (payload.iss.split("#")[0] !== ref.authority) {
      return res.status(403).json({ error: "Forbidden", message: "only the space's authority may ask" });
    }

    // Unknown spaces get no access rather than an error, so a misconfiguration fails closed.
    const read = Boolean(managed) && (await entitled(reader, managed.resource));
    // Subscribers read; only the publisher (the space authority, always authorized) writes.
    res.json({ read, write: false });
  }

  return { did, managingApp: `${did}#${SERVICE_ID}`, didDocument, checkAccess };
}
