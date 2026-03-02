#!/usr/bin/env bash
set -euo pipefail

# Gate 2: Ban raw SQL methods outside approved repository files.
#
# Approved locations for raw SQL:
#   - src/db/**              (DB layer)
#   - src/fleet/*-repository.ts  (DrizzleXxxRepository implementations)
#   - src/fleet/registration-token-store.ts
#   - src/fleet/services.ts
#   - src/fleet/node-provisioner.ts
#   - src/fleet/node-connection-manager.ts
#   - src/fleet/recovery-manager.ts
#   - src/fleet/migration-manager.ts
#   - src/fleet/fleet-manager.ts  (container.exec() is Docker API, not raw SQL)
#   - src/test/**            (test helpers)
#   - **/*.test.ts           (test files)
#
# Raw SQL patterns checked: .prepare(  and  .exec(
# NOT checked: .run( .get( .all( -- these are also Drizzle query builder
# terminators (db.select().from(table).all()), so matching them produces
# false positives. .prepare() and .exec() are the unambiguous raw-SQL indicators.

# Permanently approved file patterns (these MAY use raw SQL)
APPROVED_PATTERNS=(
  "src/db/"
  "src/fleet/[^/]*-repository\.ts"
  "src/backup/[^/]*-repository\.ts"
  "src/fleet/registration-token-store\.ts"
  "src/fleet/services\.ts"
  "src/account/[^/]*-repository\.ts"
  "src/security/credential-vault/credential-repository\.ts"
  "src/fleet/node-provisioner\.ts"
  "src/fleet/node-connection-manager\.ts"
  "src/fleet/recovery-manager\.ts"
  "src/fleet/migration-manager\.ts"
  "src/fleet/fleet-manager\.ts"  # container.exec() is Docker API, not raw SQL
  "src/security/tenant-keys/key-resolution\.ts"
  "src/security/credential-vault/key-rotation\.ts"
  "src/security/credential-vault/migration-check\.ts"
  "src/security/tenant-keys/schema\.ts"
  "src/security/tenant-keys/capability-settings-store\.ts"
  "src/admin/analytics/analytics-store\.ts"
  "src/admin/notes/notes-store\.ts"
  "src/admin/credits/adjustment-store\.ts"
  "src/admin/credits/schema\.ts"
  "src/admin/rates/rate-store\.ts"
  "src/admin/roles/role-store\.ts"
  "src/admin/users/schema\.ts"
  "src/admin/bulk/bulk-operations-store\.ts"
  "src/admin/bulk/schema\.ts"
  "src/test/"
  "\.test\.ts"
)

build_exclude_pattern() {
  local patterns=("${APPROVED_PATTERNS[@]}")
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
