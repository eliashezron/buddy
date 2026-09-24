#!/usr/bin/env bash
# Smoke test of the *compiled* app, run the way production runs it (node dist/…).
# Catches what unit tests can't: broken build output, module resolution, boot-time
# config, route wiring, the queue → worker hand-off, and shutdown.
#
# Needs: pnpm build done, migrations applied, DATABASE_URL and REDIS_URL reachable.
# Makes no model calls: it only sends messages the worker answers without the agent.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required}"

PORT="${SMOKE_PORT:-3900}"
BASE="http://127.0.0.1:$PORT"
# Placeholder credentials only. The Telegram token is the sample from Telegram's docs.
export NODE_ENV=production LOG_LEVEL=info PORT HOST=127.0.0.1
export WHATSAPP_PHONE_NUMBER_ID=smoke-phone WHATSAPP_ACCESS_TOKEN=smoke-token
export WHATSAPP_APP_SECRET=smoke-app-secret WHATSAPP_VERIFY_TOKEN=smoke-verify GRAPH_API_VERSION=v23.0
export ANTHROPIC_API_KEY=smoke-not-a-real-key
export TELEGRAM_BOT_TOKEN=123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ
export TELEGRAM_WEBHOOK_SECRET=smoke-telegram-secret-0123456789abcdef TELEGRAM_MODE=webhook
# Google connectors on, with placeholders: proves the OAuth routes and worker wiring.
export GOOGLE_CLIENT_ID=smoke-client.apps.googleusercontent.com GOOGLE_CLIENT_SECRET=smoke-secret
export TOKEN_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= PUBLIC_BASE_URL="http://localhost:$PORT"

LOGS="$(mktemp -d)"
API_PID="" WORKER_PID=""
pass() { echo "✓ $1"; }
fail() {
  echo "✗ $1" >&2
  for f in api worker count; do [[ -s "$LOGS/$f.log" ]] && { echo "--- $f log (tail)" >&2; tail -n 40 "$LOGS/$f.log" >&2; }; done
  exit 1
}
cleanup() { for p in $API_PID $WORKER_PID; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# 1. Missing config must stop boot, naming the variable.
out="$(env -u ANTHROPIC_API_KEY node apps/api/dist/index.js 2>&1)" && fail "api booted without ANTHROPIC_API_KEY"
grep -q "Missing: ANTHROPIC_API_KEY" <<<"$out" || fail "boot error did not name the missing variable: $out"
pass "missing env var fails boot with a readable message"

# 2. Boot compiled api and worker.
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node apps/api/dist/index.js >"$LOGS/api.log" 2>&1 & API_PID=$!
node apps/worker/dist/index.js >"$LOGS/worker.log" 2>&1 & WORKER_PID=$!
for _ in $(seq 1 60); do curl -fs "$BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fs "$BASE/health" | grep -q '"ok":true' || fail "GET /health"
pass "compiled api boots; /health ok"
for _ in $(seq 1 40); do grep -q '"worker started"' "$LOGS/worker.log" && break; sleep 0.5; done
grep -q '"channels":\["whatsapp","telegram"\],"google":true' "$LOGS/worker.log" || fail "worker did not start with both channels and Google connectors"
pass "compiled worker boots with whatsapp + telegram + Google connectors"

# 3. Webhook auth.
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/webhook?hub.mode=subscribe&hub.verify_token=smoke-verify&hub.challenge=42")"
[[ "$code" == 200 ]] || fail "WhatsApp verification handshake ($code)"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$BASE/webhook")"
[[ "$code" == 401 ]] || fail "unsigned WhatsApp webhook should be 401 ($code)"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'x-telegram-bot-api-secret-token: wrong' -d '{}' "$BASE/telegram/webhook")"
[[ "$code" == 401 ]] || fail "Telegram webhook with wrong secret should be 401 ($code)"
pass "webhook auth: handshake ok, unsigned and wrong-secret requests rejected"
code="$(curl -s -o "$LOGS/oauth.html" -w '%{http_code}' "$BASE/oauth/google/start?s=not-a-real-link")"
[[ "$code" == 410 ]] || fail "unknown OAuth link should be 410 ($code)"
grep -q 'This link has expired' "$LOGS/oauth.html" || fail "OAuth expired-link page"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/oauth/google/callback?state=forged&code=x")"
[[ "$code" == 410 ]] || fail "forged OAuth callback should be 410 ($code)"
pass "OAuth routes: unknown link and forged callback rejected"

# 4. Real fixtures through the real routes, then prove the worker consumed them.
#    voice-note and telegram-start are answered without the agent (no model calls).
pnpm --silent replay voice-note --send "$BASE/webhook" >/dev/null || fail "signed WhatsApp fixture not accepted"
pnpm --silent replay telegram-start --send "$BASE/telegram/webhook" >/dev/null || fail "Telegram fixture not accepted"
pass "signed WhatsApp and Telegram fixtures accepted (200)"
# Errors (e.g. DB not ready) count as 0 and are kept for the failure report.
count() { pnpm --silent exec tsx --conditions=development scripts/ci/inbound-count.ts "$1" "$since" 2>>"$LOGS/count.log" || echo 0; }
for ch in whatsapp telegram; do
  n=0
  for _ in $(seq 1 40); do n="$(count "$ch")"; [[ "$n" -ge 1 ]] && break; sleep 0.5; done
  [[ "$n" -ge 1 ]] || fail "worker did not store the $ch message"
done
pass "queue → worker → database for both channels"
grep -q '"level":"fatal"' "$LOGS/api.log" "$LOGS/worker.log" && fail "fatal log line"

# 5. Clean shutdown.
kill -TERM "$API_PID" "$WORKER_PID"
for pid in "$API_PID" "$WORKER_PID"; do
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && fail "process $pid did not exit within 30 s of SIGTERM"
  wait "$pid" || fail "process $pid exited non-zero after SIGTERM"
done
API_PID="" WORKER_PID=""
pass "api and worker exit 0 on SIGTERM"
