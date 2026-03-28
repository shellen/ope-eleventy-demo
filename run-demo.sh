#!/usr/bin/env bash
set -e

# ─────────────────────────────────────────────────────────────
# OPE Demo Suite — one-command setup and launch
#
# Installs dependencies and starts all three components:
#   1. Publisher  (ope-blog)     — Eleventy on port 8080
#   2. Gateway    (ope-gateway)  — Express  on port 4000
#   3. Reader UI  (ope-reader)   — Express  on port 3000
#
# Usage:
#   ./run-demo.sh            # install + start everything
#   ./run-demo.sh --no-install  # skip npm install, just start
#
# Then open http://localhost:3000 in your browser.
# ─────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")" && pwd)"
SKIP_INSTALL=false

for arg in "$@"; do
  case "$arg" in
    --no-install) SKIP_INSTALL=true ;;
  esac
done

# Generate a secret if one isn't already set.
# For the local demo this is fine. For production, generate once and
# store it somewhere permanent (e.g. Netlify env vars, Railway secrets).
if [ -z "$OPE_JWT_SECRET" ]; then
  export OPE_JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  GENERATED_SECRET=true
else
  GENERATED_SECRET=false
fi

echo ""
echo "  ┌─────────────────────────────────────────┐"
echo "  │         OPE Demo Suite Launcher          │"
echo "  └─────────────────────────────────────────┘"
echo ""
if [ "$GENERATED_SECRET" = true ]; then
  echo "  JWT Secret: (auto-generated for this session)"
else
  echo "  JWT Secret: (using OPE_JWT_SECRET from environment)"
fi
echo ""

# ── Install dependencies ─────────────────────────────────────

if [ "$SKIP_INSTALL" = false ]; then
  echo "  Installing dependencies..."
  echo ""

  echo "  [1/3] ope-blog (publisher)"
  (cd "$ROOT/ope-blog" && npm install --silent 2>&1 | tail -1)

  echo "  [2/3] ope-gateway"
  (cd "$ROOT/ope-gateway" && npm install --silent 2>&1 | tail -1)

  echo "  [3/3] ope-reader"
  (cd "$ROOT/ope-reader" && npm install --silent 2>&1 | tail -1)

  echo ""
  echo "  Dependencies installed."
  echo ""
fi

# ── Cleanup on exit ──────────────────────────────────────────

PIDS=()
cleanup() {
  echo ""
  echo "  Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "  Done."
}
trap cleanup EXIT INT TERM

# ── Start services ───────────────────────────────────────────

echo "  Starting services..."
echo ""

# 1. Publisher (build static site, then serve with Express on port 8080)
echo "  Building publisher site..."
(cd "$ROOT/ope-blog" && npx @11ty/eleventy --quiet 2>&1 | sed 's/^/  [publisher] /')
(cd "$ROOT/ope-blog" && node server.js 2>&1 | sed 's/^/  [publisher] /') &
PIDS+=($!)

# 2. Gateway (Express on port 4000)
(cd "$ROOT/ope-gateway" && node server.js 2>&1 | sed 's/^/  [gateway]   /') &
PIDS+=($!)

# Give the publisher and gateway a moment to start
sleep 2

# 3. Reader web UI (Express on port 3000)
(cd "$ROOT/ope-reader" && node web.js 2>&1 | sed 's/^/  [reader]    /') &
PIDS+=($!)

sleep 1

echo ""
echo "  ┌─────────────────────────────────────────┐"
echo "  │  All services running!                   │"
echo "  │                                          │"
echo "  │  Reader UI:   http://localhost:3000      │"
echo "  │  Publisher:   http://localhost:8080      │"
echo "  │  Gateway:     http://localhost:4000      │"
echo "  │                                          │"
echo "  │  Open http://localhost:3000 in a browser │"
echo "  │  Press Ctrl+C to stop all services       │"
echo "  └─────────────────────────────────────────┘"
echo ""

# Wait for any child to exit
wait
