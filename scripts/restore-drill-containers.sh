#!/bin/bash
# Container Backup Restore Drill
#
# Verifies that a tenant container backup (Docker export archive) can be
# loaded as a Docker image. Does NOT start the container — no config or
# env vars are available in the drill context.
#
# Runs on the HOST, not inside the platform-api container.
# (s3cmd is not installed in the Alpine runtime image.)
#
# Requirements:
#   - s3cmd configured for DO Spaces
#   - docker CLI
#
# Environment variables:
#   - S3_BUCKET  (default: s3://wopr-backups)
#   - DRILL_DIR  (default: /tmp/wopr-container-drill)
#
# Usage:
#   ./scripts/restore-drill-containers.sh [tenant_name]
#   # If no tenant specified, tests the most recent nightly backup found.
#
# Examples:
#   ./scripts/restore-drill-containers.sh
#   ./scripts/restore-drill-containers.sh tenant_abc

set -euo pipefail

S3_BUCKET="${S3_BUCKET:-s3://wopr-backups}"
DRILL_DIR="${DRILL_DIR:-/tmp/wopr-container-drill}"
TENANT="${1:-}"
DRILL_IMAGE="wopr-drill-test:latest"

log() {
  echo "[$(date -Iseconds)] $*"
}

error_exit() {
  log "ERROR: $*" >&2
  exit 1
}

cleanup() {
  log "Cleaning up..."
  rm -f "${DRILL_DIR}/backup.tar.gz"
  docker image rm -f "$DRILL_IMAGE" 2>/dev/null || true
}

mkdir -p "$DRILL_DIR"

DRILL_START=$(date +%s)

log "Starting container restore drill against ${S3_BUCKET}/nightly/"

# Determine which backup to test
if [ -n "$TENANT" ]; then
  # Find the most recent nightly backup for this specific tenant
  log "Finding most recent nightly backup for tenant: ${TENANT}"
  S3_PATH=$(s3cmd ls "${S3_BUCKET}/nightly/" --recursive 2>/dev/null \
    | grep "/${TENANT}/" \
    | grep '\.tar\.gz$' \
    | sort \
    | tail -1 \
    | awk '{print $NF}' || true)
else
  # Find the most recent nightly backup across all tenants
  log "Finding most recent nightly backup (any tenant)..."
  S3_PATH=$(s3cmd ls "${S3_BUCKET}/nightly/" --recursive 2>/dev/null \
    | grep '\.tar\.gz$' \
    | sort \
    | tail -1 \
    | awk '{print $NF}' || true)
fi

if [ -z "$S3_PATH" ]; then
  if [ -n "$TENANT" ]; then
    error_exit "No nightly backup found for tenant '${TENANT}' in ${S3_BUCKET}/nightly/"
  else
    error_exit "No nightly backups found in ${S3_BUCKET}/nightly/"
  fi
fi

log "Testing backup: ${S3_PATH}"

# Download the backup archive
BACKUP_LOCAL="${DRILL_DIR}/backup.tar.gz"
log "Downloading ${S3_PATH}..."
if ! s3cmd get "$S3_PATH" "$BACKUP_LOCAL"; then
  error_exit "Failed to download backup from ${S3_PATH}"
fi

# Verify non-zero size
if [ ! -s "$BACKUP_LOCAL" ]; then
  cleanup
  error_exit "Downloaded archive is empty: ${S3_PATH}"
fi

ARCHIVE_SIZE=$(wc -c < "$BACKUP_LOCAL")
log "Archive size: ${ARCHIVE_SIZE} bytes"

# Test archive integrity (list without extracting)
log "Verifying archive integrity..."
if ! tar tzf "$BACKUP_LOCAL" > /dev/null 2>&1; then
  cleanup
  error_exit "Archive is corrupt or not a valid tar.gz: ${S3_PATH}"
fi
log "Archive is a valid tar.gz"

# Load as Docker image to verify full recoverability
log "Loading archive as Docker image (this may take a moment)..."
if ! docker load < "$BACKUP_LOCAL" 2>/dev/null; then
  # docker load failed — try docker import as fallback
  log "docker load failed, trying docker import..."
  if ! docker import "$BACKUP_LOCAL" "$DRILL_IMAGE" > /dev/null 2>&1; then
    cleanup
    error_exit "Could not load backup as Docker image via load or import"
  fi
else
  log "Image loaded successfully"
fi

# Verify image exists
if ! docker image inspect "$DRILL_IMAGE" > /dev/null 2>&1; then
  # Image may have loaded with a different name — that's OK if docker load succeeded
  log "WARN: Could not find drill image tag, but archive loaded successfully"
fi

DRILL_END=$(date +%s)
ELAPSED=$((DRILL_END - DRILL_START))

log "PASS: Container backup verified (${ELAPSED}s)"
log "  Source: ${S3_PATH}"
log "  Archive size: ${ARCHIVE_SIZE} bytes"
log "  RTO (drill): ${ELAPSED}s"

cleanup
log "DRILL PASSED"
exit 0
