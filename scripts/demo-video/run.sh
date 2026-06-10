#!/usr/bin/env bash
# Demo-video pipeline entrypoint (re-runnable via `npm run demo:video`).
#
# Steps:
#   1. Guard the DB host — resolve INTEGRATION_DATABASE_URL, assert it
#      contains "dawn-forest", ABORT otherwise. We NEVER touch
#      DATABASE_URL (prod, ep-purple-credit).
#   2. db:migrate + db:seed against the integration branch.
#   3. seed-demo-data (current-week believable data).
#   4. Boot `next dev -p 3001` against integration + wait for ready.
#   5. record-demo (Playwright, one context/segment).
#   6. Tear the server down.
#   7. post-process (ffmpeg) → Sales/demo/.
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

PORT=3001
BASE_URL="http://localhost:${PORT}"

# --- resolve env from .env.local -------------------------------------------
if [ ! -f .env.local ]; then
  echo "[run] .env.local not found — cannot resolve INTEGRATION_DATABASE_URL." >&2
  exit 1
fi

IURL="$(grep -E '^INTEGRATION_DATABASE_URL=' .env.local | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
AUTH_SECRET_VAL="$(grep -E '^AUTH_SECRET=' .env.local | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"

if [ -z "${IURL}" ]; then
  echo "[run] INTEGRATION_DATABASE_URL is empty — ABORT." >&2
  exit 1
fi

HOST="$(echo "${IURL}" | sed -E 's#.*@([^/:?]+).*#\1#')"
echo "[run] integration DB host: ${HOST}"
case "${HOST}" in
  *dawn-forest*) : ;;  # ok
  *)
    echo "[run] REFUSING TO RUN: host '${HOST}' is not the integration (dawn-forest) branch. ABORT." >&2
    exit 1
    ;;
esac

export DATABASE_URL="${IURL}"
export INTEGRATION_DATABASE_URL="${IURL}"
export AUTH_SECRET="${AUTH_SECRET_VAL:-demo-secret-not-used}"
export DEMO_BASE_URL="${BASE_URL}"

# --- 2. migrate + seed ------------------------------------------------------
echo "[run] db:migrate (integration)…"
npm run db:migrate
echo "[run] db:seed (integration)…"
npm run db:seed

# --- 3. demo data -----------------------------------------------------------
echo "[run] seed-demo-data…"
npx tsx scripts/demo-video/seed-demo-data.ts

# --- 4. boot dev server -----------------------------------------------------
echo "[run] booting next dev -p ${PORT}…"
AUTH_URL="${BASE_URL}" \
AUTH_GOOGLE_ID="${AUTH_GOOGLE_ID:-demo-placeholder.apps.googleusercontent.com}" \
AUTH_GOOGLE_SECRET="${AUTH_GOOGLE_SECRET:-demo-placeholder-secret}" \
AUTH_RESEND_KEY="${AUTH_RESEND_KEY:-re_demo_placeholder}" \
  npx next dev -p "${PORT}" >/tmp/demo-next.log 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "[run] stopping dev server (pid ${SERVER_PID})…"
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "[run] waiting for ${BASE_URL} to be ready…"
READY=0
for i in $(seq 1 90); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/auth/session" 2>/dev/null || echo 000)"
  if [ "${CODE}" != "000" ]; then
    READY=1
    echo "[run] server ready (HTTP ${CODE}) after ${i}s."
    break
  fi
  sleep 1
done
if [ "${READY}" != "1" ]; then
  echo "[run] server did not become ready in 90s. Last dev log:" >&2
  tail -30 /tmp/demo-next.log >&2 || true
  exit 1
fi

# --- 5. record --------------------------------------------------------------
echo "[run] recording segments…"
npx tsx scripts/demo-video/record-demo.ts

# --- 6. teardown (trap handles the server) ----------------------------------
cleanup
trap - EXIT

# --- 7. post-process --------------------------------------------------------
echo "[run] post-processing (ffmpeg)…"
npx tsx scripts/demo-video/post-process.ts

echo "[run] DONE."
