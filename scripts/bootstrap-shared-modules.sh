#!/usr/bin/env bash
# scripts/bootstrap-shared-modules.sh
# Populates the shared node_modules Docker volume with all enabled marketplace plugins.
# Run at deploy time BEFORE starting fleet containers.
#
# Usage:
#   ./scripts/bootstrap-shared-modules.sh
#
# Environment:
#   DATABASE_URL                — PostgreSQL connection string (required)
#   SHARED_NODE_MODULES_VOLUME  — Docker volume name (default: wopr-shared-node-modules)

set -euo pipefail

VOLUME_NAME="${SHARED_NODE_MODULES_VOLUME:-wopr-shared-node-modules}"
WORK_DIR="/tmp/wopr-shared-modules-$$"

echo "[bootstrap] Fetching enabled marketplace plugins from database..."

# Query enabled plugins' npm packages + versions from the marketplace_plugins table
PACKAGES=$(psql "$DATABASE_URL" -t -A -c \
  "SELECT npm_package || '@' || version FROM marketplace_plugins WHERE enabled = true;")

if [ -z "$PACKAGES" ]; then
  echo "[bootstrap] No enabled marketplace plugins found. Creating empty volume."
  docker volume create "$VOLUME_NAME" 2>/dev/null || true
  exit 0
fi

echo "[bootstrap] Found packages:"
echo "$PACKAGES" | sed 's/^/  /'

# Create temp working directory
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

# Initialize minimal package.json
cat > "$WORK_DIR/package.json" <<'PKGJSON'
{ "name": "wopr-shared-modules", "version": "1.0.0", "private": true }
PKGJSON

# Install all packages into the temp directory
cd "$WORK_DIR"
# shellcheck disable=SC2086
echo "$PACKAGES" | xargs npm install --production --no-audit --no-fund

echo "[bootstrap] Installed $(ls node_modules | wc -l) top-level modules"

# Ensure volume exists
docker volume create "$VOLUME_NAME" 2>/dev/null || true

# Copy node_modules into the Docker volume using a temporary container
docker run --rm \
  -v "$VOLUME_NAME":/target \
  -v "$WORK_DIR/node_modules":/source:ro \
  alpine:3.19 \
  sh -c 'rm -rf /target/* && cp -a /source/. /target/'

echo "[bootstrap] Shared volume '$VOLUME_NAME' populated successfully."
echo "[bootstrap] Volume contents: $(docker run --rm -v "$VOLUME_NAME":/mnt alpine:3.19 ls /mnt | wc -l) packages"
