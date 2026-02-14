#!/bin/bash
# Platform Database Restore Script
#
# Downloads a backup from DO Spaces and restores it into the running container.
# Creates a pre-restore safety backup before overwriting.
#
# Requirements:
#   - docker CLI
#   - s3cmd configured for DO Spaces
#   - CONTAINER_NAME env var (default: wopr-platform-api)
#   - S3_BUCKET env var (default: s3://wopr-backups)
#
# Usage:
#   ./scripts/restore-platform-db.sh <database-name> <date>
#
# Examples:
#   ./scripts/restore-platform-db.sh auth 20260214
#   ./scripts/restore-platform-db.sh billing 20260213

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-wopr-platform-api}"
S3_BUCKET="${S3_BUCKET:-s3://wopr-backups}"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-/backups}"

# Database name -> container path mapping
declare -A DB_PATHS=(
  ["auth"]="/data/platform/auth.db"
  ["billing"]="/data/platform/billing.db"
  ["quotas"]="/data/platform/quotas.db"
  ["audit"]="/data/platform/audit.db"
  ["credits"]="/data/platform/credits.db"
  ["tenant-keys"]="/data/platform/tenant-keys.db"
  ["snapshots"]="/data/snapshots.db"
)

log() {
  echo "[$(date -Iseconds)] $*"
}

error_exit() {
  log "ERROR: $*" >&2
  exit 1
}

usage() {
  echo "Usage: $0 <database-name> <date>"
  echo ""
  echo "Database names: ${!DB_PATHS[*]}"
  echo "Date format: YYYYMMDD (e.g., 20260214)"
  echo ""
  echo "Examples:"
  echo "  $0 auth 20260214"
  echo "  $0 billing 20260213"
  exit 1
}

if [ $# -ne 2 ]; then
  usage
fi

DB_NAME="$1"
RESTORE_DATE="$2"

# Validate database name
if [ -z "${DB_PATHS[$DB_NAME]+x}" ]; then
  error_exit "Unknown database: ${DB_NAME}. Valid names: ${!DB_PATHS[*]}"
fi

# Validate date format
if ! echo "$RESTORE_DATE" | grep -qE '^[0-9]{8}$'; then
  error_exit "Invalid date format: ${RESTORE_DATE}. Expected YYYYMMDD."
fi

DB_CONTAINER_PATH="${DB_PATHS[$DB_NAME]}"
BACKUP_FILE="${DB_NAME}-${RESTORE_DATE}.db"
S3_PATH="${S3_BUCKET}/platform/${RESTORE_DATE}/${BACKUP_FILE}"

log "Restoring ${DB_NAME} from ${S3_PATH}"

# Verify container is running
if ! docker inspect --format='{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
  error_exit "Container $CONTAINER_NAME is not running"
fi

# Download backup from DO Spaces
mkdir -p "$LOCAL_BACKUP_DIR"
log "Downloading ${S3_PATH}..."
if ! s3cmd get "$S3_PATH" "${LOCAL_BACKUP_DIR}/${BACKUP_FILE}"; then
  error_exit "Failed to download backup from ${S3_PATH}"
fi

# Verify the downloaded file is a valid SQLite database
if ! sqlite3 "${LOCAL_BACKUP_DIR}/${BACKUP_FILE}" "PRAGMA integrity_check;" 2>/dev/null | grep -q "ok"; then
  rm -f "${LOCAL_BACKUP_DIR}/${BACKUP_FILE}"
  error_exit "Downloaded file is not a valid SQLite database"
fi

# Create pre-restore safety backup of current database
PRE_RESTORE_DATE=$(date +%Y%m%d%H%M%S)
PRE_RESTORE_FILE="${DB_NAME}-pre-restore-${PRE_RESTORE_DATE}.db"

log "Creating pre-restore safety backup..."
if docker exec "$CONTAINER_NAME" test -f "$DB_CONTAINER_PATH" 2>/dev/null; then
  if docker exec "$CONTAINER_NAME" sqlite3 "$DB_CONTAINER_PATH" ".backup /tmp/${PRE_RESTORE_FILE}"; then
    docker cp "${CONTAINER_NAME}:/tmp/${PRE_RESTORE_FILE}" "${LOCAL_BACKUP_DIR}/${PRE_RESTORE_FILE}"
    s3cmd put "${LOCAL_BACKUP_DIR}/${PRE_RESTORE_FILE}" "${S3_BUCKET}/pre-restore/${PRE_RESTORE_FILE}" 2>/dev/null || true
    docker exec "$CONTAINER_NAME" rm -f "/tmp/${PRE_RESTORE_FILE}" 2>/dev/null || true
    rm -f "${LOCAL_BACKUP_DIR}/${PRE_RESTORE_FILE}"
    log "Pre-restore backup saved"
  else
    log "WARN: Could not create pre-restore backup (database may be corrupted)"
  fi
else
  log "No existing database to back up (first-time restore)"
fi

# Stop the container to prevent writes during restore
log "Stopping container ${CONTAINER_NAME}..."
docker stop "$CONTAINER_NAME"

# Copy the backup into the container's volume
log "Restoring database..."
docker cp "${LOCAL_BACKUP_DIR}/${BACKUP_FILE}" "${CONTAINER_NAME}:${DB_CONTAINER_PATH}"

# Remove WAL and SHM files (stale after restore)
DB_DIR=$(dirname "$DB_CONTAINER_PATH")
DB_BASENAME=$(basename "$DB_CONTAINER_PATH")
docker start "$CONTAINER_NAME" --attach=false 2>/dev/null || true
# Brief wait for container to start before cleanup
sleep 1
docker exec "$CONTAINER_NAME" rm -f "${DB_CONTAINER_PATH}-wal" "${DB_CONTAINER_PATH}-shm" 2>/dev/null || true

# Restart the container
log "Starting container ${CONTAINER_NAME}..."
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker start "$CONTAINER_NAME"

# Clean up local download
rm -f "${LOCAL_BACKUP_DIR}/${BACKUP_FILE}"

log "Restore complete: ${DB_NAME} restored from ${RESTORE_DATE}"
log "The container has been restarted and will re-enable WAL mode on first query."
