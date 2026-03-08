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

# If module-service is running, trigger a rescan
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/api/modules/rescan -X POST 2>/dev/null | grep -q "200"; then
  echo "Module service rescanned — led-animator should be loaded."
else
  echo "Module service not running. Start latticeSpark to load the module."
fi
