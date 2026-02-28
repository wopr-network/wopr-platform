#!/usr/bin/env bash
set -euo pipefail

# Gate 2: Ban raw SQL methods outside approved repository files.
#
# Approved locations for raw SQL:
#   - src/db/**              (DB layer)
#   - src/fleet/*-repository.ts  (DrizzleXxxRepository implementations)
#   - src/fleet/registration-token-store.ts
#   - src/fleet/services.ts
#   - src/fleet/node-provisioner.ts (temporary - WOP-899-906)
#   - src/fleet/node-connection-manager.ts (temporary - WOP-899-906)
#   - src/fleet/recovery-manager.ts (temporary - WOP-899-906)
#   - src/fleet/migration-manager.ts (temporary - WOP-899-906)
#   - src/test/**            (test helpers)
#   - **/*.test.ts           (test files)
#
# Raw SQL patterns checked: .prepare(  and  .exec(
# NOT checked: .run( .get( .all( -- these are also Drizzle query builder
# terminators (db.select().from(table).all()), so matching them produces
# false positives. .prepare() and .exec() are the unambiguous raw-SQL indicators.
#
# TEMPORARY: Existing violations listed in TEMP_EXCLUDED_PATTERNS below.
# As WOP-899 through WOP-906 remediate each domain, remove the corresponding
# entries from TEMP_EXCLUDED_PATTERNS AND the biome.json overrides in the same PR.

# Permanently approved file patterns (these MAY use raw SQL)
APPROVED_PATTERNS=(
  "src/db/"
  "src/fleet/[^/]*-repository\.ts"
  "src/backup/[^/]*-repository\.ts"
  "src/fleet/registration-token-store\.ts"
  "src/fleet/services\.ts"
  "src/account/[^/]*-repository\.ts"
  "src/security/credential-vault/credential-repository\.ts"
  "src/test/"
  "\.test\.ts"
)

# TEMPORARY: Existing violations awaiting WOP-899-906 remediation.
# Remove each entry as its domain story merges.
TEMP_EXCLUDED_PATTERNS=(
  # WOP-900: email
  "src/email/verification\.ts"
  # WOP-902: api routes
  "src/api/routes/admin-backups\.ts"
  # WOP-904: monetization schemas
  "src/monetization/affiliate/schema\.ts"
  # WOP-905: security
  "src/security/tenant-keys/key-resolution\.ts"
  "src/security/credential-vault/key-rotation\.ts"
  "src/security/credential-vault/migrate-plaintext\.ts"
  "src/security/credential-vault/migration-check\.ts"
  "src/security/tenant-keys/schema\.ts"
  "src/security/tenant-keys/capability-settings-store\.ts"
  # WOP-899: fleet managers (temporary - WOP-899-906)
  "src/fleet/node-provisioner\.ts"
  "src/fleet/node-connection-manager\.ts"
  "src/fleet/recovery-manager\.ts"
  "src/fleet/migration-manager\.ts"
  # WOP-740: fleet-manager uses container.exec() (Docker API, not raw SQL)
  "src/fleet/fleet-manager\.ts"
  # WOP-906: admin
  "src/admin/analytics/analytics-store\.ts"
  "src/admin/notes/notes-store\.ts"
  "src/admin/credits/adjustment-store\.ts"
  "src/admin/credits/schema\.ts"
  "src/admin/rates/rate-store\.ts"
  "src/admin/roles/role-store\.ts"
  "src/admin/users/schema\.ts"
  "src/admin/bulk/bulk-operations-store\.ts"
  "src/admin/bulk/schema\.ts"
)

build_exclude_pattern() {
  local patterns=("${APPROVED_PATTERNS[@]}" "${TEMP_EXCLUDED_PATTERNS[@]}")
  local result=""
  for p in "${patterns[@]}"; do
    if [ -n "$result" ]; then
      result="${result}|${p}"
    else
      result="${p}"
    fi
  done
  echo "$result"
}

EXCLUDE=$(build_exclude_pattern)

VIOLATIONS=$(grep -rn --include="*.ts" \
  -E '\.(prepare|exec)\(' src/ \
  | awk -F: -v excl="(${EXCLUDE})" '$1 !~ excl' \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: Raw SQL methods (.prepare/.exec) found outside approved repository files:"
  echo ""
  echo "$VIOLATIONS"
  echo ""
  echo "Use Drizzle query builders (db.select/insert/update/delete) instead."
  echo "See CLAUDE.md Architectural Patterns."
  exit 1
fi

echo "Raw SQL check passed."
