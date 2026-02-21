# WOPR Platform On-Call Runbook

## Alert: gateway-capability-error-rate

**Trigger:** Any gateway capability error rate exceeds 5% in a 5-minute window.

**Severity:** High

**Steps:**
1. Check Sentry for the specific error type and stack trace.
2. Check the upstream provider status page (OpenRouter, Deepgram, ElevenLabs, etc.).
3. If a single provider is down, the gateway returns 502/503 for that capability only.
   Other capabilities remain unaffected.
4. If the error is in our code (not upstream), check recent deployments.
5. If needed, restart the platform: `docker compose restart wopr-platform`.

**Escalation:** If error rate persists >15 min, page the on-call engineer.

---

## Alert: credit-deduction-failure-spike

**Trigger:** More than 10 credit deduction failures in a 5-minute window.

**Severity:** Critical (revenue impact)

**Steps:**
1. Check if the billing database is reachable and not locked.
2. Check `data/meter-dlq.jsonl` for dead-lettered meter events.
3. Look for `InsufficientBalanceError` in logs — this may be expected
   if many tenants ran out of credits simultaneously.
4. If the SQLite DB is corrupted, restore from the latest backup:
   `docker compose exec wopr-platform node -e "require('./backup/restore-service.js')"`
5. Verify the MeterEmitter WAL (`data/meter-wal.jsonl`) is not growing unbounded.

**Escalation:** If billing DB is locked or corrupted, page immediately.

---

## Alert: fleet-unexpected-stop

**Trigger:** An org's entire bot fleet transitions from running to all-stopped.

**Severity:** High

**Steps:**
1. Check the HeartbeatWatchdog logs for node failure detection.
2. Check if the node was marked offline (RecoveryManager should auto-recover).
3. Verify Docker daemon is running on the affected node.
4. Check if this was an intentional suspension (admin action / zero balance).
5. If not intentional, check the recovery events table for the auto-recovery report.

**Escalation:** If recovery failed and bots remain down, page immediately.

---

## Health Check: GET /health

Returns `{"status":"ok","service":"wopr-platform"}` when the HTTP server is up.

## Health Check: GET /health/ready

Returns `{"status":"ready","service":"wopr-platform"}` when the server is ready to accept
traffic (DB connections healthy, gateway mounted).

## Health Check: GET /gateway/health

Returns detailed backend health with per-provider status.

## Dashboard: GET /admin/health

Returns full operational metrics (gateway rates, fleet count, credits, alerts).
Requires platform admin authentication.

---

## Uptime Monitoring

External uptime checks should be configured on:
- `GET /health` — basic liveness
- `GET /health/ready` — readiness (depends on DB)

**Recommended services (free tier):**
- UptimeRobot: https://uptimerobot.com (50 monitors free, 5-min interval)
- Better Uptime: https://betteruptime.com (10 monitors free, 3-min interval)
- Checkly: https://checkly.com (API checks with assertions)

**Alert threshold:** Non-200 for >1 minute.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SENTRY_DSN` | No | (empty = disabled) | Sentry DSN for error tracking |
| `SENTRY_RELEASE` | No | undefined | Release tag for Sentry (e.g., git SHA) |
| `ALERT_ERROR_RATE_THRESHOLD` | No | 5 | Gateway capability error rate % threshold |
| `ALERT_ERROR_RATE_WINDOW` | No | 5 | Alert window in minutes |
| `ALERT_CREDIT_FAILURE_THRESHOLD` | No | 10 | Credit failure count threshold per window |
| `ALERT_WEBHOOK_URL` | No | (empty) | Webhook URL for alert notifications |
