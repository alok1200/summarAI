#!/bin/bash
# Start the Next.js dev server in a fully detached, persistent way.
cd "$(dirname "$0")/.."

# Kill any existing next processes
pkill -9 -f "next-server" 2>/dev/null
pkill -9 -f "next dev" 2>/dev/null
sleep 2

# Start dev server with nohup, fully detached from the shell
nohup node node_modules/.bin/next dev -p 3000 > dev.log 2>&1 &
DEV_PID=$!
echo "Started dev server with PID: $DEV_PID"

# Wait for it to be ready
for i in {1..30}; do
  if curl -s -o /dev/null http://localhost:3000/ 2>/dev/null; then
    echo "Dev server is ready!"
    break
  fi
  sleep 1
done

# Verify it's still running
if ps -p $DEV_PID > /dev/null 2>&1; then
  echo "Dev server is running."
else
  echo "ERROR: Dev server died!"
  tail -20 dev.log
  exit 1
fi
