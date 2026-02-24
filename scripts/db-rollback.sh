#!/usr/bin/env bash
# scripts/db-rollback.sh
# Manual database rollback procedure for wopr-platform.
#
# WHEN TO USE:
#   A deploy introduced a bad migration and the health check passed
#   (data corruption, not a crash). This is rare — most migration
#   failures will crash the app and trigger the image rollback.
#
# PREREQUISITES:
#   - SSH access to production host
#   - The deploy workflow creates backups at /opt/wopr-platform/backups/
#
# PROCEDURE:
#   1. Stop the platform service:
#      docker compose -f /opt/wopr-platform/docker-compose.yml stop platform-api
#
#   2. List available backups:
#      ls -lt /opt/wopr-platform/backups/platform_*.db
#
#   3. Restore the backup (pick the one from BEFORE the bad deploy):
#      cp /opt/wopr-platform/backups/platform_20260224_120000.db \
#         /opt/wopr-platform/data/platform/platform.db
#
#   4. Roll back the Docker image to the previous version:
#      docker compose -f /opt/wopr-platform/docker-compose.yml up -d platform-api
#      (The deploy workflow saves the previous SHA tag in .previous-sha-tag)
#
#   5. Verify health:
#      curl -sf http://localhost:3100/health
#
# IMPORTANT:
#   - SQLite WAL mode means you must also remove platform.db-wal and
#     platform.db-shm if they exist, as they may contain transactions
#     from after the backup.
#   - After restoring, the drizzle __drizzle_migrations table will
#     reflect the backup's migration state. The old image's migrate()
#     call will be a no-op since it matches.
#
# This script is documentation only. Run the commands manually.
set -euo pipefail
echo "This script is a runbook — read the comments and run commands manually."
echo "See: scripts/db-rollback.sh"
exit 0
