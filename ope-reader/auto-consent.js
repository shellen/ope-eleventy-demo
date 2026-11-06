// ABOUTME: Drives the demo License Server's sign-in and consent forms without a browser.
// ABOUTME: Demo and test use only: a real app opens the authorization URL in the person's browser.

// Returns the redirect the License Server sends back: { code, state, iss } or { error, ... }.
// choose: "approve", "deny", or "offer:<id>" (the demo's stand-in for checkout).
export async function autoAuthorize(authorizationUrl, { account, choose = "approve" }) {
  const origin = new URL(authorizationUrl).origin;
  let cookie = "";

  const follow = async (res) => {
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    if (res.status === 303 || res.status === 302) {
      const location = new URL(res.headers.get("location"), origin);
      if (location.origin === origin) return follow(await fetch(location, { headers: { cookie }, redirect: "manual" }));
      return Object.fromEntries(location.searchParams);
    }
    return { html: await res.text(), status: res.status };
  };
  const post = async (path, fields) => follow(await fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  }));
  const txnOf = (html) => (html.match(/name="txn" value="([^"]+)"/) || [])[1];

  let step = await follow(await fetch(authorizationUrl, { redirect: "manual" }));
  if (!step.html) return step; // an error redirect before sign-in
  if (/action="\/login"/.test(step.html)) step = await post("/login", { txn: txnOf(step.html), account });
  if (!step.html) return step;
  const txn = txnOf(step.html);
  if (!txn) throw new Error(`unexpected License Server page (${step.status})`);
  return post("/consent", { txn, action: choose });
}
