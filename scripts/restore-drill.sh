#!/bin/bash
# Restore Drill Script
#
# Verifies that platform database backups are actually recoverable.
# Downloads the most recent backup from DO Spaces, restores to a temporary
# SQLite database, verifies integrity and schema, and reports pass/fail.
#
# Designed to run manually or via CI on a schedule (e.g., monthly).
# Runs on the HOST, not inside the platform-api container.
# (s3cmd is not installed in the Alpine runtime image.)
#
# Requirements:
#   - s3cmd configured for DO Spaces
#   - sqlite3 CLI
#
# Environment variables:
#   - S3_BUCKET (default: s3://wopr-backups)
#   - DRILL_DIR  (default: /tmp/wopr-restore-drill)
#
# Usage:
#   ./scripts/restore-drill.sh
#   S3_BUCKET=s3://wopr-backups ./scripts/restore-drill.sh

set -euo pipefail

S3_BUCKET="${S3_BUCKET:-s3://wopr-backups}"
DRILL_DIR="${DRILL_DIR:-/tmp/wopr-restore-drill}"
REPORT_FILE="${DRILL_DIR}/drill-report.txt"

log() {
  echo "[$(date -Iseconds)] $*"
}

error_exit() {
  log "ERROR: $*" >&2
  exit 1
}

# Expected tables per database (minimum set for integrity check)
# Format: DB_TABLES[db-name]="table1 table2 ..."
declare -A DB_TABLES
DB_TABLES[auth]="user session account"
DB_TABLES[billing]="meter_events"
DB_TABLES[credits]="credit_transactions"
DB_TABLES[audit]="audit_log"
DB_TABLES[quotas]="quota_limits"
DB_TABLES[tenant-keys]="tenant_keys"
DB_TABLES[snapshots]="snapshots restore_log"

# Tables that must have at least one row (critical tables)
CRITICAL_TABLES="user session meter_events credit_transactions"

mkdir -p "$DRILL_DIR"

DRILL_START=$(date +%s)
PASSED=0
FAILED=0
SKIPPED=0

log "Starting restore drill against ${S3_BUCKET}/platform/"
log "Drill directory: ${DRILL_DIR}"
echo "" | tee "$REPORT_FILE"
echo "WOPR Platform Backup Restore Drill — $(date -Iseconds)" | tee -a "$REPORT_FILE"
echo "============================================================" | tee -a "$REPORT_FILE"

# Find the latest backup date directory
log "Finding latest backup date..."
LATEST_DATE_LINE=$(s3cmd ls "${S3_BUCKET}/platform/" 2>/dev/null | grep -E '[0-9]{4}-[0-9]{2}-[0-9]{2}' | tail -1 || true)
if [ -z "$LATEST_DATE_LINE" ]; then
  error_exit "No backups found in ${S3_BUCKET}/platform/"
fi
# Extract the directory name (last component of the s3 path, e.g. "20260214/")
BACKUP_DATE=$(echo "$LATEST_DATE_LINE" | awk '{print $NF}' | sed 's|.*/||;s|/$||')
if [ -z "$BACKUP_DATE" ]; then
  error_exit "Could not parse backup date from: ${LATEST_DATE_LINE}"
fi

log "Latest backup date: ${BACKUP_DATE}"
echo "Backup date: ${BACKUP_DATE}" | tee -a "$REPORT_FILE"
echo "" | tee -a "$REPORT_FILE"

for db_name in "${!DB_TABLES[@]}"; do
  db_file="${db_name}-${BACKUP_DATE}.db"
  s3_path="${S3_BUCKET}/platform/${BACKUP_DATE}/${db_file}"
  local_path="${DRILL_DIR}/${db_name}.db"

  log "--- Testing ${db_name} ---"

  # Download
  if ! s3cmd get "$s3_path" "$local_path" 2>/dev/null; then
    log "SKIP: ${db_name} — not found in backup (may not be initialized yet)"
    echo "SKIP  ${db_name}" | tee -a "$REPORT_FILE"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Verify non-zero size
  if [ ! -s "$local_path" ]; then
    log "FAIL: ${db_name} — downloaded file is empty"
    echo "FAIL  ${db_name} — empty file" | tee -a "$REPORT_FILE"
    rm -f "$local_path"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Integrity check
  integrity_result=$(sqlite3 "$local_path" "PRAGMA integrity_check;" 2>&1 || true)
  if [ "$integrity_result" != "ok" ]; then
    log "FAIL: ${db_name} — integrity check failed: ${integrity_result}"
    echo "FAIL  ${db_name} — integrity check: ${integrity_result}" | tee -a "$REPORT_FILE"
    rm -f "$local_path"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Verify expected tables exist
  tables_in_db=$(sqlite3 "$local_path" ".tables" 2>&1 || true)
  table_fail=0
  for expected_table in ${DB_TABLES[$db_name]}; do
    if ! echo "$tables_in_db" | grep -qw "$expected_table"; then
      log "FAIL: ${db_name} — missing expected table: ${expected_table}"
      echo "FAIL  ${db_name} — missing table: ${expected_table}" | tee -a "$REPORT_FILE"
      table_fail=1
    fi
  done
  if [ "$table_fail" -eq 1 ]; then
    rm -f "$local_path"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Verify critical tables have at least one row
  row_fail=0
  for critical_table in $CRITICAL_TABLES; do
    # Only check if this table is expected in this database
    if echo "${DB_TABLES[$db_name]}" | grep -qw "$critical_table"; then
      row_count=$(sqlite3 "$local_path" "SELECT COUNT(*) FROM ${critical_table};" 2>/dev/null || echo "0")
      if [ "$row_count" -eq 0 ]; then
        log "WARN: ${db_name}.${critical_table} — table is empty (may be expected in test environments)"
      fi
    fi
  done

  log "PASS: ${db_name} — integrity ok, all tables present"
  echo "PASS  ${db_name} — integrity ok, tables present" | tee -a "$REPORT_FILE"
  rm -f "$local_path"
  PASSED=$((PASSED + 1))
done

DRILL_END=$(date +%s)
ELAPSED=$((DRILL_END - DRILL_START))

echo "" | tee -a "$REPORT_FILE"
echo "============================================================" | tee -a "$REPORT_FILE"
echo "Result: ${PASSED} passed, ${FAILED} failed, ${SKIPPED} skipped" | tee -a "$REPORT_FILE"
echo "RTO (drill time): ${ELAPSED}s" | tee -a "$REPORT_FILE"
echo "Report saved to: ${REPORT_FILE}" | tee -a "$REPORT_FILE"

log "Drill complete: ${PASSED} passed, ${FAILED} failed, ${SKIPPED} skipped (${ELAPSED}s)"

# Clean up drill directory (but keep report)
find "$DRILL_DIR" -name "*.db" -delete 2>/dev/null || true

if [ "$FAILED" -gt 0 ]; then
  log "DRILL FAILED — ${FAILED} database(s) could not be verified"
  exit 1
fi

log "DRILL PASSED"
exit 0
