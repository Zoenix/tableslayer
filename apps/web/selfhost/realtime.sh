#!/bin/sh
# Runs the realtime worker (PartyServer + Durable Objects) in workerd via wrangler's
# local runtime. Room state persists to $REALTIME_DATA_PATH. No Cloudflare account needed.
set -e
cd "$(dirname "$0")/.."

: "${INTERNAL_API_TOKEN:?INTERNAL_API_TOKEN must be set (same value as the web container)}"
APP_API_URL="${APP_API_URL:-http://web:3000}"
REALTIME_DATA_PATH="${REALTIME_DATA_PATH:-/data/realtime}"
REALTIME_PORT="${REALTIME_PORT:-1999}"
mkdir -p "$REALTIME_DATA_PATH"

export WRANGLER_SEND_METRICS=false
export CI=true

exec node_modules/.bin/wrangler dev \
  --config partyserver/wrangler.jsonc \
  --local \
  --ip 0.0.0.0 \
  --port "$REALTIME_PORT" \
  --persist-to "$REALTIME_DATA_PATH" \
  --var "APP_API_URL:$APP_API_URL" \
  --var "INTERNAL_API_TOKEN:$INTERNAL_API_TOKEN" \
  --show-interactive-dev-session=false \
  --log-level "${REALTIME_LOG_LEVEL:-info}"
