#!/bin/bash
# DO Spaces Lifecycle and Bucket Structure Setup
#
# Creates the expected directory structure in DO Spaces and documents
# the retention policies. DO Spaces uses S3-compatible lifecycle rules.
#
# Requirements:
#   - s3cmd configured for DO Spaces
#   - S3_BUCKET env var (default: s3://wopr-backups)
#
# Usage:
#   ./scripts/setup-do-spaces-lifecycle.sh

set -euo pipefail

S3_BUCKET="${S3_BUCKET:-s3://wopr-backups}"

log() {
  echo "[$(date -Iseconds)] $*"
}

# Create directory markers for the expected bucket structure.
# DO Spaces uses S3-style prefix-based "directories".
log "Creating bucket directory structure in ${S3_BUCKET}..."

for prefix in platform latest nightly on-demand pre-restore migrations; do
  # Create a zero-byte marker object to establish the prefix
  echo -n "" | s3cmd put - "${S3_BUCKET}/${prefix}/.keep" 2>/dev/null || true
  log "  ${prefix}/"
done

log ""
log "Bucket structure:"
log "  ${S3_BUCKET}/"
log "  ├── platform/           <- Platform DB backups (sqlite3 .backup)"
log "  │   └── {date}/"
log "  │       ├── auth-{date}.db"
log "  │       ├── billing-{date}.db"
log "  │       ├── quotas-{date}.db"
log "  │       ├── audit-{date}.db"
log "  │       ├── credits-{date}.db"
log "  │       ├── tenant-keys-{date}.db"
log "  │       └── snapshots-{date}.db"
log "  ├── latest/             <- HOT tenant backups (overwritten every 6h)"
log "  │   └── {tenant}/"
log "  │       └── latest.tar.gz"
log "  ├── nightly/            <- COLD tenant snapshots (retained)"
log "  │   └── {node}/{tenant}/"
log "  │       └── {tenant}_{date}.tar.gz"
log "  ├── on-demand/          <- User-triggered snapshots"
log "  │   └── {tenant}/"
log "  │       └── {snapshot-id}_{name}.tar.gz"
log "  ├── pre-restore/        <- Safety snapshots before restore"
log "  │   └── {db}-pre-restore-{timestamp}.db"
log "  └── migrations/         <- Migration temp files"
log "      └── {tenant}.tar.gz"
log ""
log "Retention policies (configure via DO Spaces lifecycle rules):"
log ""
log "  platform/*:"
log "    - Keep 30 daily backups"
log "    - Keep 90 weekly backups (oldest per week)"
log "    - Keep the very first backup forever"
log "    - Lifecycle rule: Expire objects older than 120 days"
log "      (weekly pruning handled by cleanup-platform-backups.sh cron)"
log ""
log "  latest/*:"
log "    - Overwritten every 6h (no lifecycle rule needed)"
log ""
log "  nightly/*:"
log "    - Keep 7 daily snapshots"
log "    - Keep 4 weekly snapshots"
log "    - Lifecycle rule: Expire objects older than 30 days"
log ""
log "  on-demand/*:"
log "    - Retention per tier (managed by application)"
log ""
log "  pre-restore/*:"
log "    - Keep for 30 days"
log "    - Lifecycle rule: Expire objects older than 30 days"
log ""
log "  migrations/*:"
log "    - Temporary files, expire after 7 days"
log "    - Lifecycle rule: Expire objects older than 7 days"
log ""
log "To configure DO Spaces lifecycle rules via the DO console:"
log "  1. Navigate to Spaces > wopr-backups > Settings > Lifecycle Rules"
log "  2. Add rules matching the policies above"
log ""
log "Or via s3cmd (S3-compatible lifecycle):"
log "  s3cmd setlifecycle lifecycle.xml ${S3_BUCKET}"
log ""
log "See scripts/lifecycle.xml for the lifecycle configuration."

# Generate lifecycle.xml for S3-compatible lifecycle rules
cat > /tmp/wopr-lifecycle.xml << 'LIFECYCLE_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration>
  <!-- Platform DB backups: expire after 120 days (weekly pruning via cron) -->
  <Rule>
    <ID>platform-expire-120d</ID>
    <Prefix>platform/</Prefix>
    <Status>Enabled</Status>
    <Expiration>
      <Days>120</Days>
    </Expiration>
  </Rule>

  <!-- Nightly tenant snapshots: expire after 30 days -->
  <Rule>
    <ID>nightly-expire-30d</ID>
    <Prefix>nightly/</Prefix>
    <Status>Enabled</Status>
    <Expiration>
      <Days>30</Days>
    </Expiration>
  </Rule>

  <!-- Pre-restore safety backups: expire after 30 days -->
  <Rule>
    <ID>pre-restore-expire-30d</ID>
    <Prefix>pre-restore/</Prefix>
    <Status>Enabled</Status>
    <Expiration>
      <Days>30</Days>
    </Expiration>
  </Rule>

  <!-- Migration temp files: expire after 7 days -->
  <Rule>
    <ID>migrations-expire-7d</ID>
    <Prefix>migrations/</Prefix>
    <Status>Enabled</Status>
    <Expiration>
      <Days>7</Days>
    </Expiration>
  </Rule>
</LifecycleConfiguration>
LIFECYCLE_EOF

log "Lifecycle XML written to /tmp/wopr-lifecycle.xml"
log "Apply with: s3cmd setlifecycle /tmp/wopr-lifecycle.xml ${S3_BUCKET}"
