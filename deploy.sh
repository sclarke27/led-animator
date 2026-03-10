#!/bin/bash
# Deploy led-animator module to a latticeSpark instance
# Usage: ./deploy.sh /path/to/latticeSpark
#        ./deploy.sh                         (uses LATTICESPARK_HOME env var)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$LATTICESPARK_HOME}"

if [ -z "$TARGET" ]; then
  echo "Usage: ./deploy.sh /path/to/latticeSpark"
  echo "   or: set LATTICESPARK_HOME environment variable"
  exit 1
fi

MODULES_DIR="$TARGET/modules/led-animator"

echo "Deploying led-animator module to $MODULES_DIR ..."

# Create target directory if needed
mkdir -p "$MODULES_DIR"

# Copy module files (excluding node/ which runs on RPi)
cp -r "$SCRIPT_DIR/module/"* "$MODULES_DIR/"

echo "Deployed successfully."

# Read API key from env or latticeSpark cluster config
API_KEY="${LATTICESPARK_API_KEY:-}"
if [ -z "$API_KEY" ] && [ -f "$TARGET/config/cluster.json" ]; then
  API_KEY=$(grep -o '"apiKey"\s*:\s*"[^"]*"' "$TARGET/config/cluster.json" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"$//' || true)
fi

AUTH_HEADER=""
if [ -n "$API_KEY" ]; then
  AUTH_HEADER="-H X-API-Key:$API_KEY"
fi

# If module-service is running, trigger a rescan
RESCAN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" $AUTH_HEADER http://localhost:3002/api/modules/rescan -X POST 2>/dev/null || true)
if [ "$RESCAN_STATUS" = "200" ]; then
  echo "Module service rescanned — led-animator should be loaded."
elif [ "$RESCAN_STATUS" = "000" ]; then
  echo "Could not connect to module service on port 3002."
  echo "Check that latticeSpark is running and verify the correct port."
else
  echo "Module service returned HTTP $RESCAN_STATUS on rescan."
  echo "Check latticeSpark logs for errors loading led-animator."
fi
