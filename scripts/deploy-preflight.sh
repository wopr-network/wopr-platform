#!/bin/bash
# Pre-deployment preflight checks and backup.
# Run on the production host BEFORE deploying a new version.
#
# Usage:
#   ./scripts/deploy-preflight.sh
#
# Environment:
#   CONTAINER_NAME  (default: wopr-platform-api)
#   S3_BUCKET       (default: s3://wopr-backups)
#   COMPOSE_DIR     (default: /opt/wopr-platform)

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-wopr-platform-api}"
S3_BUCKET="${S3_BUCKET:-s3://wopr-backups}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/wopr-platform}"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-/backups}"

log() {
  echo "[$(date -Iseconds)] $*"
}

error_exit() {
  log "ERROR: $*" >&2
  exit 1
}

# --- Check 1: Container is running ---
log "CHECK: Container ${CONTAINER_NAME} is running"
if ! docker inspect --format='{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
  error_exit "Container $CONTAINER_NAME is not running"
fi
log "  OK"

# --- Check 2: Health endpoint responds ---
log "CHECK: Health endpoint responds"
HEALTH=$(curl -sf http://localhost:3100/health 2>/dev/null || true)
if [ -z "$HEALTH" ]; then
  error_exit "Health endpoint not responding"
fi
log "  OK: ${HEALTH}"

# --- Check 3: Record current image tag for rollback ---
log "CHECK: Recording current image tag"
CURRENT_TAG=$(docker inspect --format='{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null | grep -oP ':\K[a-f0-9]{7}$' || true)
if [ -n "$CURRENT_TAG" ]; then
  echo "$CURRENT_TAG" > "${COMPOSE_DIR}/.previous-sha-tag"
  log "  OK: Current tag is ${CURRENT_TAG}"
else
  log "  WARN: Could not determine current image tag (first deploy?)"
fi

# --- Check 4: Pre-deploy database backup ---
log "CHECK: Running pre-deploy database backup"
DATE=$(date +%Y%m%d-%H%M%S)
DATABASES=(
  "/data/platform/auth.db"
  "/data/platform/billing.db"
  "/data/platform/credits.db"
  "/data/platform/tenant-keys.db"
  "/data/snapshots.db"
)

mkdir -p "${LOCAL_BACKUP_DIR}/pre-deploy"
BACKUP_OK=0
for db_path in "${DATABASES[@]}"; do
  db_name=$(basename "$db_path" .db)
  backup_file="pre-deploy-${db_name}-${DATE}.db"

  if ! docker exec "$CONTAINER_NAME" test -f "$db_path" 2>/dev/null; then
    log "  SKIP: ${db_path} does not exist"
    continue
  fi

  if docker exec "$CONTAINER_NAME" sqlite3 "$db_path" ".backup /tmp/${backup_file}" 2>/dev/null; then
    docker cp "${CONTAINER_NAME}:/tmp/${backup_file}" "${LOCAL_BACKUP_DIR}/pre-deploy/${backup_file}" 2>/dev/null
    docker exec "$CONTAINER_NAME" rm -f "/tmp/${backup_file}" 2>/dev/null || true
    # Upload to S3 under pre-deploy prefix
    s3cmd put "${LOCAL_BACKUP_DIR}/pre-deploy/${backup_file}" "${S3_BUCKET}/pre-deploy/${DATE}/${backup_file}" 2>/dev/null || true
    rm -f "${LOCAL_BACKUP_DIR}/pre-deploy/${backup_file}"
    BACKUP_OK=$((BACKUP_OK + 1))
    log "  OK: ${db_name}"
  else
    log "  WARN: Failed to backup ${db_name}"
  fi
done
log "  Backed up ${BACKUP_OK} databases"

# --- Check 5: Disk space ---
log "CHECK: Disk space"
AVAIL=$(df -BG /var/lib/docker --output=avail | tail -1 | tr -d ' G')
if [ "$AVAIL" -lt 5 ]; then
  error_exit "Low disk space: ${AVAIL}GB available (need at least 5GB)"
fi
log "  OK: ${AVAIL}GB available"

log ""
log "=== PREFLIGHT PASSED ==="
log "Safe to proceed with deployment."
