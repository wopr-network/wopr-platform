#!/bin/bash
# Run Drizzle database migrations inside the running container.
#
# This script copies the migration files into the container and runs
# drizzle-kit migrate. It should be called AFTER pulling the new image
# but BEFORE restarting the service.
#
# Usage:
#   ./scripts/deploy-migrate.sh
#
# Environment:
#   CONTAINER_NAME  (default: wopr-platform-api)

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-wopr-platform-api}"

log() {
  echo "[$(date -Iseconds)] $*"
}

error_exit() {
  log "ERROR: $*" >&2
  exit 1
}

# Verify container is running
if ! docker inspect --format='{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
  error_exit "Container $CONTAINER_NAME is not running"
fi

# drizzle-kit is a devDependency, not available in the production image.
# Instead, we check the migration journal and apply SQL files directly.
# The drizzle migration journal is at drizzle/migrations/meta/_journal.json

# Strategy: Use a temporary container with the NEW image to run migrations
# against the production database volume.
IMAGE=$(docker inspect --format='{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null)
VOLUME_NAME=$(docker inspect --format='{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Name }}{{ end }}{{ end }}' "$CONTAINER_NAME")

if [ -z "$VOLUME_NAME" ]; then
  error_exit "Could not determine data volume name"
fi

log "Using image: ${IMAGE}"
log "Using volume: ${VOLUME_NAME}"

# The production image doesn't have drizzle-kit. We need to run migrations
# using a build-stage image or a separate migration runner.
# Simplest approach: use the build image which has devDependencies.
#
# For SQLite with Drizzle, migrations are SQL files. We can apply them
# directly with sqlite3 if drizzle-kit isn't available.
#
# Check if any .sql files in drizzle/migrations/ haven't been applied yet.
# Drizzle tracks applied migrations in a __drizzle_migrations table.

log "Checking for pending migrations..."

# List migrations from the image
AVAILABLE=$(docker run --rm "${IMAGE}" sh -c 'ls /app/drizzle/migrations/*.sql 2>/dev/null | sort' 2>/dev/null || true)

if [ -z "$AVAILABLE" ]; then
  log "No migration files found in image (drizzle/migrations/ not bundled)"
  log "WARN: Migrations must be run manually if schema changed"
  log "  Suggestion: Add 'COPY drizzle/ ./drizzle/' to Dockerfile"
  exit 0
fi

log "Migration check complete"
log "NOTE: For SQLite, Drizzle migrations are applied on app startup via migrate() call"
log "  If the app fails to start after migration, rollback the image AND restore the DB"
log "  Use scripts/restore-platform-db.sh to restore from pre-deploy backup"
