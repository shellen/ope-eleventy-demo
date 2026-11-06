#!/usr/bin/env bash
set -e

# ─────────────────────────────────────────────────────────────
# OPE Demo Suite (spec v0.2): one-command setup and launch
#
#   1. Publisher       (ope-blog)            Eleventy + Express on port 8080
#   2. License Server  (ope-license-server)  Express on port 4000
#   3. Reader UI       (ope-reader)          Express on port 3000
#
# Usage:
#   ./run-demo.sh               # install + start everything
#   ./run-demo.sh --no-install  # skip npm install, just start
#
# Then open http://localhost:3000, or run the CLI reader in another terminal:
#   cd ope-reader && node reader.js --auto alice
# ─────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")" && pwd)"
SKIP_INSTALL=false
for arg in "$@"; do
  case "$arg" in
    --no-install) SKIP_INSTALL=true ;;
  esac
done

# The publisher's introspection credential at the License Server (spec §13.4).
# A real one is issued once, out of band; for the demo, a fresh one per run.
# Both servers read it, so revocation takes effect at the publisher at once.
if [ -z "$OPE_RS_CLIENT_SECRET" ]; then
  export OPE_RS_CLIENT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))")
fi
export OPE_RS_CLIENT_ID="${OPE_RS_CLIENT_ID:-ope-demo-blog}"

echo ""
echo "  OPE Demo Suite (spec v0.2)"
echo ""

if [ "$SKIP_INSTALL" = false ]; then
  echo "  Installing dependencies..."
  (cd "$ROOT/eleventy-plugin-ope" && npm install --silent 2>&1 | tail -1)
  (cd "$ROOT/ope-blog" && npm install --silent 2>&1 | tail -1)
  (cd "$ROOT/ope-license-server" && npm install --silent 2>&1 | tail -1)
  (cd "$ROOT/ope-reader" && npm install --silent 2>&1 | tail -1)
  echo ""
fi

PIDS=()
cleanup() {
  echo ""
  echo "  Shutting down..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

echo "  Building the publisher site..."
(cd "$ROOT/ope-blog" && npx @11ty/eleventy --quiet 2>&1 | sed 's/^/  [publisher] /')

(cd "$ROOT/ope-blog" && node server.js 2>&1 | sed 's/^/  [publisher] /') &
PIDS+=($!)
(cd "$ROOT/ope-license-server" && node server.js 2>&1 | sed 's/^/  [license]   /') &
PIDS+=($!)
sleep 2
(cd "$ROOT/ope-reader" && node web.js 2>&1 | sed 's/^/  [reader]    /') &
PIDS+=($!)
sleep 1

echo ""
echo "  Reader UI:       http://localhost:3000"
echo "  Publisher:       http://localhost:8080"
echo "  License Server:  http://localhost:4000  (your account: /account)"
echo ""
echo "  CLI reader:      cd ope-reader && node reader.js --auto alice"
echo "  Press Ctrl+C to stop."
echo ""
wait
