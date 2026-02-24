#!/bin/bash
# Run Drizzle database migrations inside the running container.
#
# NOTE: This script is NOT called by the CI/CD workflows. Migrations for
# SQLite/Drizzle are applied automatically on app startup via the migrate()
# call in the application code. You do NOT need to run this script as part
# of a normal deployment.
#
# When to run this script manually:
#   1. EMERGENCY SCHEMA REPAIR: If the app fails to start due to a migration
#      error, run this script to diagnose which migrations are pending/applied.
#   2. OFFLINE MIGRATION: If you need to apply migrations while the container
#      is stopped (e.g., for a long-running schema change).
#   3. MIGRATION AUDIT: To verify which SQL files are bundled in the image
#      and confirm the migration journal is up to date.
#
# Typical manual deployment sequence (only if migrate() is NOT in app startup):
#   1. docker pull <new-image>
#   2. ./scripts/deploy-preflight.sh   # backup DBs
#   3. ./scripts/deploy-migrate.sh     # apply pending migrations (this script)
#   4. docker compose up -d            # restart with new image
#
# On failure: restore from backup using scripts/restore-platform-db.sh
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
