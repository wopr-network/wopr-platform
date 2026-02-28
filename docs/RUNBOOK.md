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

---

## On-Call Observability Runbook (WOP-825)

### Quick Health Check

```bash
# Readiness probe (should return 200)
curl -f http://localhost:3100/health/ready

# Admin health dashboard (requires admin token)
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3100/admin/health
```

The admin health dashboard returns:
- `gateway.last5m` — request/error rates over the last 5 minutes
- `gateway.last60m` — request/error rates over the last hour
- `fleet.activeBots` — count of active bot instances
- `billing.creditsConsumed24h` — total credits consumed in last 24h (cents)
- `alerts` — current alert statuses

### Alerts

#### 1. gateway-error-rate

**Trigger:** Gateway capability error rate exceeds 5% over a 5-minute window.

**Symptoms:** Users report bot API calls failing. Sentry shows new error types.

**Investigation steps:**
1. Check `GET /admin/health` for the `byCapability` breakdown to identify which capability is failing.
2. Check Sentry for the specific error messages and stack traces.
3. Check upstream provider status pages (OpenRouter, Deepgram, ElevenLabs, Replicate, Twilio).
4. Check `GET /health` for backend health status.

**Resolution:**
- If upstream provider is down: Wait for them to recover. Alert resolves automatically when error rate drops below 5%.
- If platform code is throwing: Check Sentry for stack traces. Roll back recent deploy if needed.

#### 2. credit-deduction-spike

**Trigger:** More than 10 credit deduction failures in a 5-minute window.

**Symptoms:** Billing errors in logs. Users may get API errors despite having credits.

**Investigation steps:**
1. Check logs for `Credit debit failed after proxy` messages.
2. Check the billing database for lock contention or corruption.
3. Check disk space on the billing DB volume.

**Resolution:**
- Billing DB lock: Restart platform API container (releases SQLite WAL locks).
- Disk full: Free up space or expand volume.
- Alert resolves automatically when failures drop below threshold.

#### 3. fleet-unexpected-stop

**Trigger:** Bot fleet stopped unexpectedly (event-driven, not polled).

**Symptoms:** Users report bots are unresponsive. Fleet status shows all bots stopped.

**Investigation steps:**
1. Check `docker ps` on fleet nodes.
2. Check node agent logs for crash reasons.
3. Check `GET /internal/nodes` for node connection status.

**Resolution:**
- Restart fleet nodes via admin API.
- If nodes are unreachable, provision replacement nodes.

### Error Tracking (Sentry)

Sentry is enabled when `SENTRY_DSN` environment variable is set. Without it, all `captureError`/`captureMessage` calls are no-ops.

- Errors are tagged with `source` (unhandledRejection, uncaughtException)
- Alert firings are sent as Sentry messages with level `warning`
- Check Sentry for new error types, not every occurrence (deduplication is enabled)

### Uptime Monitoring

Configure an external uptime check on:
- `GET /health` — general health check
- `GET /health/ready` — readiness probe (returns `{"status":"ready","service":"wopr-platform"}`)

Recommended services: Better Uptime, UptimeRobot, or Checkly (all have free tiers).
Alert if either returns non-200 for more than 1 minute.

---

## Happy Path Manual Test — Sign Up, Pay, Bot Runs

Run this after any significant billing, auth, or fleet change to confirm the full customer journey works end-to-end against a local dev stack.

### Prerequisites

- Docker + Docker Compose installed
- Stripe CLI installed (`stripe version`)
- `psql` available (for DB inspection)
- `.env` populated with test-mode Stripe keys (run `pnpm setup` if needed)

---

### 0. Start the stack (fresh)

```bash
cd ~/wopr-platform

# Wipe volume and start clean
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d

# Wait for healthy
sleep 10
docker logs wopr-platform-platform-api-1 --tail 5
# Expected last line: "wopr-platform listening on http://0.0.0.0:3100"
```

---

### 1. Sign up

```bash
curl -sD /tmp/signup_hdrs.txt -X POST http://localhost:3100/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"name":"Test User","email":"testuser@example.com","password":"Testpass1"}' | jq '.user.id, .user.email'
```

**Expected:** `"<user-id>"` and `"testuser@example.com"`

---

### 2. Capture session token

```bash
SESSION=$(grep -i "better-auth.session_token" /tmp/signup_hdrs.txt \
  | sed 's/.*better-auth.session_token=\([^;]*\).*/\1/' \
  | head -1)
echo "SESSION: $SESSION"
```

**Expected:** A non-empty token string.

> The session cookie is scoped to `.wopr.bot`, so browsers won't send it to `localhost`. Always pass it manually via `-H "Cookie: better-auth.session_token=$SESSION"` with `-H "Origin: http://localhost:3000"`.

---

### 3. Confirm session is valid

```bash
curl -s "http://localhost:3100/trpc/billing.creditsBalance?input=%7B%7D" \
  -H "Origin: http://localhost:3000" \
  -H "Cookie: better-auth.session_token=$SESSION" | jq .
```

**Expected:**

```json
{"result":{"data":{"tenant":"<id>","balance_cents":0,"daily_burn_cents":0,"runway_days":null}}}
```

If you get `Authentication required`, the session is invalid — repeat step 1.

---

### 4. Create a Stripe checkout session

```bash
PRICE_ID=$(grep "^STRIPE_CREDITS_PRICE" ~/wopr-platform/.env | head -1 | cut -d= -f2 | tr -d '"')

curl -s -X POST http://localhost:3100/trpc/billing.creditsCheckout \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -H "Cookie: better-auth.session_token=$SESSION" \
  -d "{\"priceId\":\"$PRICE_ID\",\"successUrl\":\"http://localhost:3000/dashboard\",\"cancelUrl\":\"http://localhost:3000/dashboard\"}" | jq '.result.data'
```

**Expected:**

```json
{"url": "https://checkout.stripe.com/c/pay/cs_test_...", "sessionId": "cs_test_..."}
```

---

### 5. Simulate Stripe payment (webhook)

**5a. Create a Stripe test customer:**

```bash
STRIPE_KEY=$(grep STRIPE_SECRET_KEY ~/wopr-platform/.env | cut -d= -f2)

CUS=$(stripe customers create \
  --api-key "$STRIPE_KEY" \
  --email "testuser@example.com" \
  --name "Test User" 2>&1 | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Customer: $CUS"
```

**5b. Get the tenant ID:**

```bash
TENANT=$(curl -s "http://localhost:3100/trpc/billing.creditsBalance?input=%7B%7D" \
  -H "Origin: http://localhost:3000" \
  -H "Cookie: better-auth.session_token=$SESSION" | jq -r '.result.data.tenant')
echo "Tenant: $TENANT"
```

**5c. Start `stripe listen` and update webhook secret:**

```bash
# Start listener — note the "webhook signing secret" it prints, then Ctrl-C
stripe listen --api-key "$STRIPE_KEY" --forward-to http://localhost:3100/api/billing/webhook
# Copy: whsec_xxxx...
```

Update `STRIPE_WEBHOOK_SECRET=whsec_xxxx...` in `.env`, then restart:

```bash
docker compose -f docker-compose.dev.yml down && docker compose -f docker-compose.dev.yml up -d
sleep 8
```

> The `stripe listen` signing secret differs from the dashboard webhook secret. You must use the listener's secret when forwarding locally.

**5d. Fire the webhook:**

```bash
stripe listen --api-key "$STRIPE_KEY" \
  --forward-to http://localhost:3100/api/billing/webhook \
  --events checkout.session.completed &
LISTEN_PID=$!
sleep 4

stripe trigger checkout.session.completed \
  --api-key "$STRIPE_KEY" \
  --add "checkout_session:client_reference_id=$TENANT" \
  --add "checkout_session:metadata[wopr_tenant]=$TENANT" \
  --add "checkout_session:customer=$CUS"

sleep 5
kill $LISTEN_PID 2>/dev/null
```

**Expected:**

```
--> checkout.session.completed [evt_xxx]
<-- [200] POST http://localhost:3100/api/billing/webhook [evt_xxx]
```

---

### 6. Confirm credits landed

```bash
curl -s "http://localhost:3100/trpc/billing.creditsBalance?input=%7B%7D" \
  -H "Origin: http://localhost:3000" \
  -H "Cookie: better-auth.session_token=$SESSION" | jq '.result.data.balance_cents'
```

**Expected:** A positive number (e.g., `3000` depending on the price tier).

If balance still shows `0` after a successful webhook 200 response, verify the credit ledger wiring: check platform logs for errors in the `checkout.session.completed` handler.

For direct DB verification:

```bash
# Connect to the Postgres database inside the container
docker exec -it <postgres-container> psql -U <user> -d <db> -c "SELECT * FROM credit_transactions ORDER BY created_at DESC LIMIT 5;"
```

> Note: The exact Postgres connection details depend on your `.env` configuration. Check `DATABASE_URL` or `POSTGRES_*` env vars.

---

### 7. Create a bot

```bash
curl -s -X POST http://localhost:3100/trpc/fleet.createInstance \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -H "Cookie: better-auth.session_token=$SESSION" \
  -d '{"name":"test-bot","image":"wopr-network/wopr:latest","description":"Happy path test bot"}' | jq '.result.data'
```

**Expected:** JSON with `id`, `name`, `status` (likely `"provisioning"` or `"created"`).

> The `fleet.createInstance` tRPC procedure injects `tenantId` from the session — do not include it in the payload.

---

### 8. Confirm bot is running

```bash
BOT_ID="<id from step 7>"

curl -s "http://localhost:3100/trpc/fleet.getInstance?input=%7B%22id%22%3A%22$BOT_ID%22%7D" \
  -H "Origin: http://localhost:3000" \
  -H "Cookie: better-auth.session_token=$SESSION" | jq '.result.data.status'
```

**Expected:** `"running"` (may take a few seconds after creation; poll if needed).

---

### Checklist

- [ ] Stack starts clean from fresh volume
- [ ] Sign-up returns user object
- [ ] Session token captured, `creditsBalance` returns 0
- [ ] `creditsCheckout` returns a Stripe URL
- [ ] Webhook fires and returns 200
- [ ] `creditsBalance` returns correct positive amount
- [ ] Bot created successfully via `fleet.createInstance`
- [ ] Bot status transitions to running
