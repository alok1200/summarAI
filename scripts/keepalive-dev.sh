#!/usr/bin/env bash
# Keepalive watchdog for the Next.js dev server.
# Restarts `next dev` if it dies, and probes /api/health every 10s to detect
# silent hangs (process alive but not responding).
#
# Usage: nohup bash scripts/keepalive-dev.sh > dev.log 2>&1 &

set -u
cd "$(dirname "$0")/.."
PORT=3000
HEALTH_URL="http://localhost:${PORT}/api/health"
MAX_SILENT_FAILURES=3   # restart after 3 consecutive health-check failures

start_server() {
  echo "[keepalive] $(date -u +%FT%TZ) starting next dev on :${PORT}"
  nohup node node_modules/.bin/next dev -p "${PORT}" > /tmp/next-dev.out 2>&1 &
  SERVER_PID=$!
  echo "[keepalive] next dev PID=${SERVER_PID}"
}

# Make sure no stale server is hogging the port
pkill -9 -f "next dev" 2>/dev/null
pkill -9 -f "next-server" 2>/dev/null
sleep 1

start_server
consecutive_failures=0

while true; do
  sleep 10

  # Check if the process is still alive
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "[keepalive] $(date -u +%FT%TZ) next dev died (exit), restarting..."
    consecutive_failures=0
    start_server
    continue
  fi

  # Health probe
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${HEALTH_URL}" 2>/dev/null || echo "000")
  if [ "${http_code}" = "200" ]; then
    consecutive_failures=0
  else
    consecutive_failures=$((consecutive_failures + 1))
    echo "[keepalive] $(date -u +%FT%TZ) health check failed (${http_code}), ${consecutive_failures}/${MAX_SILENT_FAILURES}"
    if [ "${consecutive_failures}" -ge "${MAX_SILENT_FAILURES}" ]; then
      echo "[keepalive] $(date -u +%FT%TZ) silent hang detected, killing + restarting..."
      kill -9 "${SERVER_PID}" 2>/dev/null
      pkill -9 -f "next-server" 2>/dev/null
      pkill -9 -f "postcss" 2>/dev/null
      sleep 2
      consecutive_failures=0
      start_server
    fi
  fi
done
