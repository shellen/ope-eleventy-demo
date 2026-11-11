#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# OPE Demo Suite (spec v0.2): deploy both Workers to Cloudflare
#
# One command puts the whole demo on your Cloudflare account, on Workers'
# free plan:
#
#   1. License Server  (ope-license-server)  https://ope-license-server.<subdomain>.workers.dev
#   2. Publisher       (ope-blog)            https://ope-demo.<subdomain>.workers.dev
#
# then runs the reader's full flow against them to prove they work.
#
# Usage:
#   ./deploy-cloudflare.sh                 # deploy, then test
#   ./deploy-cloudflare.sh --skip-test     # deploy only
#
# The only manual step is signing in to Cloudflare in your browser the first
# time (wrangler login). Set CLOUDFLARE_API_TOKEN instead to skip that, and
# CLOUDFLARE_ACCOUNT_ID if your login can reach more than one account.
#
# Optional:
#   OPE_LS_NAME=my-license-server  OPE_BLOG_NAME=my-blog  ./deploy-cloudflare.sh
#
# Safe to run again: it redeploys both Workers and generates a fresh shared
# secret for both. The License Server keeps its accounts, subscriptions, and
# signing key (they live in its Durable Object).
#
# Workers deployed this way aren't connected to GitHub, so pushes don't
# redeploy them; run the script again, or connect them in the dashboard
# (Worker → Settings → Build).
# ─────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")" && pwd)"
LS_NAME="${OPE_LS_NAME:-ope-license-server}"
BLOG_NAME="${OPE_BLOG_NAME:-ope-demo}"
RUN_TEST=true
for arg in "$@"; do
  case "$arg" in
    --skip-test) RUN_TEST=false ;;
    -h|--help) sed -n '4,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 1 ;;
  esac
done

# Overridable for testing: the command that runs wrangler.
WRANGLER="${WRANGLER:-npx --no-install wrangler}"
export WRANGLER_SEND_METRICS="${WRANGLER_SEND_METRICS:-false}"

step() { printf '\n  \033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
fail() { printf '\n  \033[31m✘ %s\033[0m\n\n' "$1" >&2; exit 1; }

# ── 0. Prerequisites ─────────────────────────────────────────
command -v node >/dev/null || fail "Node.js 20 or later is required: https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20 or later is required (found $(node -v))."

echo ""
echo "  OPE demo → Cloudflare Workers"
echo "  License Server: $LS_NAME    Publisher: $BLOG_NAME"

step "1/6  Installing dependencies"
(cd "$ROOT/ope-license-server" && npm install --no-audit --no-fund --silent)
(cd "$ROOT/ope-blog" && npm install --no-audit --no-fund --silent)
info "Done."

step "2/6  Signing in to Cloudflare"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && ! (cd "$ROOT/ope-license-server" && $WRANGLER whoami 2>/dev/null | grep -qi "associated with the email\|logged in"); then
  info "Opening your browser to sign in (wrangler login)…"
  (cd "$ROOT/ope-license-server" && $WRANGLER login)
fi
info "Signed in."

# Deploy one Worker; print its workers.dev address (taken from wrangler's output).
deploy() {
  local dir="$1" name="$2"; shift 2
  local log
  log="$(mktemp)"
  if ! (cd "$ROOT/$dir" && $WRANGLER deploy --name "$name" "$@") >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$log"
    fail "Deploying $name failed (output above)."
  fi
  local url
  url="$(grep -oE "https://$name\.[a-z0-9-]+\.workers\.dev" "$log" | head -1 || true)"
  rm -f "$log"
  [ -n "$url" ] || fail "Deployed $name, but couldn't find its workers.dev address in wrangler's output."
  echo "$url"
}

# Put a secret on a Worker, read from stdin so it never appears in a command line.
put_secret() {
  local dir="$1" name="$2" key="$3" value="$4"
  printf '%s' "$value" | (cd "$ROOT/$dir" && $WRANGLER secret put "$key" --name "$name") >/dev/null 2>&1 \
    || fail "Setting $key on $name failed. Try: cd $dir && npx wrangler secret put $key --name $name"
}

# ── 3. License Server ────────────────────────────────────────
# The first deploy also tells us your workers.dev subdomain, which gives
# both addresses. The License Server generates and keeps its own signing key.
step "3/6  Deploying the License Server"
LS_URL="$(deploy ope-license-server "$LS_NAME")"
SUBDOMAIN="${LS_URL#https://$LS_NAME.}"
SUBDOMAIN="${SUBDOMAIN%.workers.dev}"
BLOG_URL="https://$BLOG_NAME.$SUBDOMAIN.workers.dev"
info "License Server: $LS_URL"
info "Publisher will be: $BLOG_URL"

# Now that the publisher's address is known, tell the License Server what it
# issues for (its protected resources).
LS_URL="$(deploy ope-license-server "$LS_NAME" --var "OPE_PROTECTED_RESOURCES:$BLOG_URL/posts/")"

# ── 4. Shared secret ─────────────────────────────────────────
# The publisher's introspection credential at the License Server (spec §13.4):
# generated here, written to both Workers, never printed.
step "4/6  Setting the shared introspection secret"
SECRET="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"
put_secret ope-license-server "$LS_NAME" OPE_RS_CLIENT_SECRET "$SECRET"
info "Set on $LS_NAME."

# ── 5. Publisher ─────────────────────────────────────────────
# The build bakes both addresses into the site's metadata, so the Worker
# itself needs only the secret.
step "5/6  Deploying the publisher"
export OPE_SITE_URL="$BLOG_URL" OPE_LICENSE_SERVER="$LS_URL"
BLOG_URL="$(deploy ope-blog "$BLOG_NAME")"
put_secret ope-blog "$BLOG_NAME" OPE_RS_CLIENT_SECRET "$SECRET"
unset SECRET
info "Publisher: $BLOG_URL"

# ── 6. Test ──────────────────────────────────────────────────
step "6/6  Testing the live demo"
if [ "$RUN_TEST" = false ]; then
  info "Skipped (--skip-test)."
else
  # Wait for both Workers to answer (a new workers.dev address can take a moment).
  for url in "$LS_URL/.well-known/oauth-authorization-server" "$BLOG_URL/.well-known/oauth-protected-resource/posts/"; do
    for i in $(seq 1 30); do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)"
      [ "$code" = "200" ] && break
      sleep 2
    done
    [ "$code" = "200" ] || fail "$url isn't answering yet (HTTP $code). Wait a minute and rerun with the test only: node ope-reader/reader.js --publisher $BLOG_URL --auto test"
  done
  # Behind a proxy, Node's fetch needs to be told to use it.
  [ -n "${HTTPS_PROXY:-}${https_proxy:-}" ] && export NODE_USE_ENV_PROXY=1
  OUT="$(node "$ROOT/ope-reader/reader.js" --publisher "$BLOG_URL" --auto "deploy-check-$RANDOM" 2>&1 || true)"
  if grep -q "^  200 OK" <<<"$OUT" && grep -q "Revoked. The publisher now answers 401" <<<"$OUT"; then
    info "✔ Subscribed, read a gated post, refreshed, and revoked, through both live Workers."
  else
    echo "$OUT" | sed 's/^/    /'
    fail "The live test didn't pass (output above)."
  fi
fi

echo ""
echo "  ┌──────────────────────────────────────────────────────────────"
echo "  │ The OPE demo is live."
echo "  │"
echo "  │ Reader app:      $BLOG_URL/reader/"
echo "  │ Publisher:       $BLOG_URL"
echo "  │ License Server:  $LS_URL   (your account: $LS_URL/account)"
echo "  │"
echo "  │ CLI reader:      node ope-reader/reader.js --publisher $BLOG_URL"
echo "  └──────────────────────────────────────────────────────────────"
echo ""
