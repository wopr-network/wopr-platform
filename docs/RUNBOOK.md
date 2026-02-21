# WOPR Platform Restore Runbook

## Architecture Overview

### What Gets Backed Up

| Component | Backup Method | Schedule | Storage Location | Retention |
|-----------|--------------|----------|------------------|-----------|
| Platform DBs (auth, billing, credits, audit, quotas, tenant-keys, snapshots) | `scripts/backup-platform-dbs.sh` — SQLite `.backup` | Nightly via cron | `s3://wopr-backups/platform/{DATE}/` | 30 days |
| Tenant containers | `BackupManager.runNightly()` — Docker export | Nightly via platform command | `s3://wopr-backups/nightly/{nodeId}/{containerName}/` | Per tier (7–365 days) |
| Tenant containers (hot) | `HotBackupScheduler` — Docker export, changed only | Every 6 hours | `s3://wopr-backups/latest/{containerName}/latest.tar.gz` | Overwritten each cycle |
| WOPR_HOME snapshots | `SnapshotManager.create()` | On-demand + nightly | Local `{snapshotDir}/{instanceId}/` + DO Spaces | Per tier |

### Offsite Storage

All backups are stored in **DigitalOcean Spaces** (S3-compatible object storage), which is:
- Geographically separate from the primary compute nodes
- Replicated within the DO region
- Accessible from any machine with s3cmd credentials

The primary server stores **no long-term backups locally** — all are uploaded to Spaces and local copies cleaned up.

---

## Restore Procedures

### Procedure 1: Platform Database Restore

**When to use:** Platform API is corrupted, database lost, or server replacement.

**Prerequisites:**
- s3cmd configured with DO Spaces credentials
- docker CLI
- sqlite3 CLI

**Steps:**

1. Identify the backup date to restore from:
   ```bash
   s3cmd ls s3://wopr-backups/platform/
   ```

2. Stop the platform API container:
   ```bash
   docker compose stop platform-api
   ```

3. Download all database backups for the target date:
   ```bash
   DATE=20260214
   mkdir -p /data/restore
   for db in auth billing credits audit quotas tenant-keys snapshots; do
     s3cmd get "s3://wopr-backups/platform/${DATE}/${db}-${DATE}.db" "/data/restore/${db}.db"
   done
   ```

4. Verify integrity of each downloaded database:
   ```bash
   for db in /data/restore/*.db; do
     echo "Checking ${db}..."
     sqlite3 "${db}" "PRAGMA integrity_check;"
   done
   ```
   Each must output `ok`. If any output errors, do NOT proceed with that database.

5. Back up current databases (safety net):
   ```bash
   TIMESTAMP=$(date +%s)
   for db in auth billing credits audit quotas tenant-keys; do
     cp "/data/platform/${db}.db" "/data/platform/${db}.db.pre-restore-${TIMESTAMP}" 2>/dev/null || true
   done
   cp "/data/snapshots.db" "/data/snapshots.db.pre-restore-${TIMESTAMP}" 2>/dev/null || true
   ```

6. Replace databases with restored copies:
   ```bash
   cp /data/restore/auth.db /data/platform/auth.db
   cp /data/restore/billing.db /data/platform/billing.db
   cp /data/restore/credits.db /data/platform/credits.db
   cp /data/restore/audit.db /data/platform/audit.db
   cp /data/restore/quotas.db /data/platform/quotas.db
   cp /data/restore/tenant-keys.db /data/platform/tenant-keys.db
   cp /data/restore/snapshots.db /data/snapshots.db
   ```

7. Restart the platform API:
   ```bash
   docker compose up -d platform-api
   ```

8. Verify the API is healthy:
   ```bash
   curl -f http://localhost:3100/health
   ```
   Expected response: `{"status":"ok","service":"wopr-platform"}`

9. Check admin backup status:
   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3100/api/admin/backups
   ```

---

### Procedure 2: Tenant Container Restore

**When to use:** A tenant's bot container is corrupted or needs rollback.

**Option A: Via Admin API (recommended)**

```bash
# List available snapshots for a tenant container
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3100/api/admin/backups/tenant_${TENANT_ID}/snapshots"

# Initiate restore from a specific snapshot
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"remotePath": "nightly/node-1/tenant_abc/tenant_abc_20260214.tar.gz"}' \
  "http://localhost:3100/api/admin/backups/tenant_${TENANT_ID}/restore"
```

**Option B: Via RestoreService (programmatic)**

The `RestoreService` at `src/backup/restore-service.ts` handles the full flow:
1. Pre-restore safety snapshot (export current container)
2. Upload pre-restore snapshot to DO Spaces
3. Stop current container
4. Remove current container
5. Download backup snapshot from DO Spaces to node
6. Import snapshot as new image and start container
7. Verify container is running
8. Log the restore event

**Option C: Manual (last resort)**

```bash
# On the target node:
NODE_ID=node-1
CONTAINER=tenant_abc
DATE=20260214

# 1. Safety snapshot of current state
docker export ${CONTAINER} | gzip > /backups/${CONTAINER}_pre_restore.tar.gz
s3cmd put /backups/${CONTAINER}_pre_restore.tar.gz s3://wopr-backups/pre-restore/${CONTAINER}/

# 2. Download the backup
s3cmd get "s3://wopr-backups/nightly/${NODE_ID}/${CONTAINER}/${CONTAINER}_${DATE}.tar.gz" /backups/

# 3. Stop and remove the current container
docker stop ${CONTAINER}
docker rm ${CONTAINER}

# 4. Import the backup as a new image and start
docker import /backups/${CONTAINER}_${DATE}.tar.gz ${CONTAINER}:restored
docker run -d --name ${CONTAINER} ${CONTAINER}:restored

# 5. Verify the container is running
docker ps | grep ${CONTAINER}
```

---

### Procedure 3: Full Server Replacement

**When to use:** Primary server is completely lost.

1. Provision a new server.
2. Install Docker, s3cmd, Node.js 24+.
3. Configure s3cmd with DO Spaces credentials:
   ```bash
   s3cmd --configure
   ```
4. Clone the wopr-platform repo and build:
   ```bash
   git clone https://github.com/wopr-network/wopr-platform.git
   cd wopr-platform
   pnpm install && pnpm build
   ```
5. Follow **Procedure 1** to restore platform databases.
6. For each tenant that was on the lost node, follow **Procedure 2**.
7. Restart the platform stack:
   ```bash
   docker compose up -d
   ```

---

## Recovery Time Objectives (RTO)

| Scenario | Estimated RTO | Notes |
|----------|--------------|-------|
| Single platform DB restore | < 5 minutes | Download + integrity check + copy + restart |
| All 7 platform DBs | < 15 minutes | Sequential download and verify |
| Single tenant container | 5–10 minutes | Download, import, start |
| Full server replacement | 1–2 hours | New server + all DBs + all containers |

**RTO measurement:** Run `./scripts/restore-drill.sh` periodically to measure actual download and verify times.

---

## Backup Verification (Restore Drill)

Run the restore drill monthly to confirm backups are actually recoverable:

```bash
# Platform databases
./scripts/restore-drill.sh

# Container backups
./scripts/restore-drill-containers.sh [tenant_name]
```

The restore drill:
1. Downloads the most recent backup from DO Spaces
2. Runs `PRAGMA integrity_check` on each database
3. Verifies all expected tables exist
4. Reports pass/fail and elapsed time (RTO measurement)
5. Cleans up all temporary files

---

## Monitoring & Alerts

### Backup Health Check

- `GET /health` — includes `backups` field when backup DB is available:
  - `status: "ok"` — all backups fresh (< 24h)
  - `status: "degraded"` — one or more stale backups; HTTP 200 always returned
- `GET /api/admin/backups/alerts/stale` — lists containers with stale backups (> 24h since last successful backup)

### Stale Backup Alert

A backup is considered **stale** if:
- `lastBackupAt` is null (never backed up), or
- `lastBackupSuccess` is false, or
- elapsed time since `lastBackupAt` > 24 hours

The `BackupStatusStore.listStale()` method implements this check.

### Restore Drill Schedule

Recommended schedule:
- **Monthly:** Run `./scripts/restore-drill.sh` to verify platform databases
- **Quarterly:** Run `./scripts/restore-drill-containers.sh` to verify container backups

---

## Offsite Storage Verification

All backups are stored in **DigitalOcean Spaces** (S3-compatible):

| Setting | Value |
|---------|-------|
| Bucket | Configured via `S3_BUCKET` env var (default: `wopr-backups`) |
| Region | Configured via `DO_SPACES_REGION` env var |
| Access key | `DO_SPACES_ACCESS_KEY` env var |
| Secret key | `DO_SPACES_SECRET_KEY` env var |

DO Spaces is a **separate service** from Droplets — if the server dies, Spaces data survives.

To verify offsite access from a different machine:

```bash
# List the last 5 platform backup dates
s3cmd --config=/path/to/s3cfg ls s3://wopr-backups/platform/ | tail -5

# Verify backup files for a specific date
s3cmd --config=/path/to/s3cfg ls s3://wopr-backups/platform/20260214/
```

Expected output lists all 7 database files (`auth-*.db`, `billing-*.db`, etc.) with non-zero sizes.
