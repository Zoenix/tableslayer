#!/bin/sh
# Runs the realtime worker (PartyServer + Durable Objects) in workerd via wrangler's
# local runtime. Room state persists to $REALTIME_DATA_PATH. No Cloudflare account needed.
set -e
cd "$(dirname "$0")/.."

: "${INTERNAL_API_TOKEN:?INTERNAL_API_TOKEN must be set (same value as the web container)}"
APP_API_URL="${APP_API_URL:-http://web:3000}"
REALTIME_DATA_PATH="${REALTIME_DATA_PATH:-/data/realtime}"
REALTIME_PORT="${REALTIME_PORT:-1999}"
DATA_ROOT="${DATA_ROOT:-/data}"

# Room state outside a host mount is discarded whenever the container is recreated
case "$REALTIME_DATA_PATH" in
  "$DATA_ROOT"/*)
    if [ "${REQUIRE_DATA_MOUNT:-true}" != "false" ] && [ -r /proc/self/mountinfo ] &&
      ! awk -v d="$DATA_ROOT" '$5 == d { found = 1 } END { exit !found }' /proc/self/mountinfo; then
      echo "❌ $DATA_ROOT is not mounted from the host; realtime state would be lost on update." >&2
      echo "   Mount the same host folder at $DATA_ROOT as the web container." >&2
      exit 1
    fi
    ;;
esac
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
