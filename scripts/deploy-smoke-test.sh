#!/bin/bash
# Post-deployment smoke test.
# Verifies the platform is serving requests correctly after a deploy.
#
# Usage:
#   ./scripts/deploy-smoke-test.sh [base_url]
#
# Arguments:
#   base_url  (default: http://localhost:3100)

set -euo pipefail

BASE_URL="${1:-http://localhost:3100}"
FAILURES=0

log() {
  echo "[$(date -Iseconds)] $*"
}

check() {
  local name="$1"
  local url="$2"
  local expected_status="${3:-200}"

  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  if [ "$STATUS" = "$expected_status" ]; then
    log "  PASS: ${name} (${STATUS})"
  else
    log "  FAIL: ${name} -- expected ${expected_status}, got ${STATUS}"
    FAILURES=$((FAILURES + 1))
  fi
}

log "=== POST-DEPLOY SMOKE TEST ==="
log "Target: ${BASE_URL}"
log ""

# --- Liveness ---
log "Liveness checks:"
check "GET /health" "${BASE_URL}/health"
check "GET /health/ready" "${BASE_URL}/health/ready"

# --- API responds ---
log ""
log "API checks:"
check "GET / (root)" "${BASE_URL}/" "404"

# --- Verify health response body ---
log ""
log "Health response body:"
HEALTH_BODY=$(curl -sf "${BASE_URL}/health" 2>/dev/null || echo "{}")
log "  ${HEALTH_BODY}"

# Check that status is not "error"
if echo "$HEALTH_BODY" | grep -q '"status":"error"'; then
  log "  FAIL: Health status is 'error'"
  FAILURES=$((FAILURES + 1))
fi

# --- Domain resolution (if running from CI) ---
if [ -n "${DOMAIN:-}" ]; then
  log ""
  log "Domain checks:"
  for subdomain in "" "app." "api."; do
    FQDN="${subdomain}${DOMAIN}"
    IP=$(dig +short "$FQDN" @1.1.1.1 2>/dev/null | head -1)
    if [ -n "$IP" ]; then
      log "  PASS: ${FQDN} -> ${IP}"
    else
      log "  WARN: ${FQDN} does not resolve"
    fi
  done
fi

log ""
if [ "$FAILURES" -gt 0 ]; then
  log "=== SMOKE TEST FAILED (${FAILURES} failures) ==="
  exit 1
else
  log "=== SMOKE TEST PASSED ==="
fi
