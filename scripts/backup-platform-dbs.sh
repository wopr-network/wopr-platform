#!/bin/bash
# Platform Database Backup Script
#
# Uses SQLite's .backup command for crash-consistent snapshots.
# Runs nightly via cron: /etc/cron.daily/wopr-platform-backup
#
# Requirements:
#   - docker CLI
#   - s3cmd configured for DO Spaces (see setup-do-spaces-lifecycle.sh)
#   - CONTAINER_NAME env var (default: wopr-platform-api)
#   - S3_BUCKET env var (default: s3://wopr-backups)
#
# Usage:
#   ./scripts/backup-platform-dbs.sh
#   CONTAINER_NAME=my-api S3_BUCKET=s3://my-bucket ./scripts/backup-platform-dbs.sh

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-wopr-platform-api}"
S3_BUCKET="${S3_BUCKET:-s3://wopr-backups}"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-/backups}"
DATE=$(date +%Y%m%d)

# Encryption key for AES-256 (must be set in environment)
ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"

encrypt_file() {
  local src="$1"
  local dst="${src}.enc"
  if [ -n "$ENCRYPTION_KEY" ]; then
    openssl enc -aes-256-cbc -salt -pbkdf2 -in "$src" -out "$dst" -pass env:BACKUP_ENCRYPTION_KEY
    rm -f "$src"
    echo "$dst"
  else
    error_exit "BACKUP_ENCRYPTION_KEY is not set — refusing to upload unencrypted backup"
  fi
}

# Platform databases to back up (path inside the container)
DATABASES=(
  "/data/platform/auth.db"
  "/data/platform/billing.db"
  "/data/platform/quotas.db"
  "/data/platform/audit.db"
  "/data/platform/credits.db"
  "/data/platform/tenant-keys.db"
  "/data/snapshots.db"
)

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

# Create local backup directory
mkdir -p "$LOCAL_BACKUP_DIR"

BACKED_UP=0
FAILED=0

for db_path in "${DATABASES[@]}"; do
  db_name=$(basename "$db_path" .db)
  backup_file="${db_name}-${DATE}.db"
  container_tmp="/tmp/${backup_file}"

  log "Backing up ${db_path}..."

  # Check if the database exists in the container
  if ! docker exec "$CONTAINER_NAME" test -f "$db_path" 2>/dev/null; then
    log "SKIP: ${db_path} does not exist in container (not yet initialized)"
    continue
  fi

  # Use SQLite .backup for crash-consistent snapshot
  if ! docker exec "$CONTAINER_NAME" sqlite3 "$db_path" ".backup ${container_tmp}"; then
    log "WARN: sqlite3 .backup failed for ${db_path}"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Copy out of container
  if ! docker cp "${CONTAINER_NAME}:${container_tmp}" "${LOCAL_BACKUP_DIR}/${backup_file}"; then
    log "WARN: docker cp failed for ${backup_file}"
    docker exec "$CONTAINER_NAME" rm -f "${container_tmp}" 2>/dev/null || true
    FAILED=$((FAILED + 1))
    continue
  fi

  # Encrypt before upload
  upload_file=$(encrypt_file "${LOCAL_BACKUP_DIR}/${backup_file}")
  upload_name=$(basename "$upload_file")
  if ! s3cmd put "$upload_file" "${S3_BUCKET}/platform/${DATE}/${upload_name}"; then
    log "WARN: s3cmd upload failed for ${upload_name}"
    rm -f "$upload_file"
    docker exec "$CONTAINER_NAME" rm -f "${container_tmp}" 2>/dev/null || true
    FAILED=$((FAILED + 1))
    continue
  fi

  # Clean up
  rm -f "$upload_file"
  docker exec "$CONTAINER_NAME" rm -f "${container_tmp}" 2>/dev/null || true

  BACKED_UP=$((BACKED_UP + 1))
  log "OK: ${db_name} backed up to ${S3_BUCKET}/platform/${DATE}/${backup_file}"
done

log "Backup complete: ${BACKED_UP} succeeded, ${FAILED} failed"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
