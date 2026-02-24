#!/bin/bash
# Manual rollback to the previous deployment.
#
# Reads the SHA tag from .previous-sha-tag, pulls that image,
# re-tags as :latest, and restarts the service.
#
# Usage:
#   ./scripts/deploy-rollback.sh [sha-tag]
#
# Arguments:
#   sha-tag   Override the tag to roll back to (optional; reads .previous-sha-tag if omitted)
#
# Environment:
#   IMAGE       (default: ghcr.io/wopr-network/wopr-platform)
#   SERVICE     (default: platform-api)
#   COMPOSE_DIR (default: /opt/wopr-platform)

set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/wopr-network/wopr-platform}"
SERVICE="${SERVICE:-platform-api}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/wopr-platform}"

log() {
  echo "[$(date -Iseconds)] $*"
}

error_exit() {
  log "ERROR: $*" >&2
  exit 1
}

# Determine rollback target
if [ -n "${1:-}" ]; then
  PREV_TAG="$1"
  log "Rolling back to specified tag: ${PREV_TAG}"
else
  PREV_TAG=$(cat "${COMPOSE_DIR}/.previous-sha-tag" 2>/dev/null || true)
  if [ -z "$PREV_TAG" ]; then
    error_exit "No previous SHA tag found. Specify one: $0 <sha-tag>"
  fi
  log "Rolling back to previous tag: ${PREV_TAG}"
fi

# Capture current tag before rollback (so we can roll forward if needed)
CURRENT_TAG=$(docker inspect --format='{{.Config.Image}}' "$(docker compose -f "${COMPOSE_DIR}/docker-compose.yml" ps -q "${SERVICE}" 2>/dev/null)" 2>/dev/null | grep -oP ':\K[a-f0-9]{7}$' || true)

# Pre-rollback backup
log "Creating pre-rollback database backup..."
if [ -f "${COMPOSE_DIR}/scripts/deploy-preflight.sh" ]; then
  bash "${COMPOSE_DIR}/scripts/deploy-preflight.sh" || log "WARN: Preflight backup failed, continuing with rollback"
fi

# Pull and deploy the previous image
log "Pulling ${IMAGE}:${PREV_TAG}..."
docker pull "${IMAGE}:${PREV_TAG}"

log "Re-tagging as :latest..."
docker tag "${IMAGE}:${PREV_TAG}" "${IMAGE}:latest"

log "Restarting ${SERVICE}..."
cd "${COMPOSE_DIR}"
docker compose up -d --force-recreate "${SERVICE}"

# Health check
log "Waiting for health check..."
for i in $(seq 1 15); do
  if curl -sf http://localhost:3100/health > /dev/null 2>&1; then
    log "Health check passed after rollback"

    # Save the rolled-back-from tag so we can roll forward
    if [ -n "$CURRENT_TAG" ]; then
      echo "$CURRENT_TAG" > "${COMPOSE_DIR}/.rolled-back-from-tag"
      log "Saved rolled-back-from tag: ${CURRENT_TAG}"
    fi

    log "=== ROLLBACK COMPLETE ==="
    log "Rolled back to: ${IMAGE}:${PREV_TAG}"
    log "To roll forward: $0 ${CURRENT_TAG:-<tag>}"
    exit 0
  fi
  echo "  Waiting... ($i/15)"
  sleep 5
done

error_exit "Health check failed after rollback! Manual intervention required."
