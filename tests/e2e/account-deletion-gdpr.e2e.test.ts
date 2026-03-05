import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { createTestDb } from "../../src/test/db.js";
import { AccountDeletionStore } from "../../src/account/deletion-store.js";
import { DrizzleDeletionRepository } from "../../src/account/deletion-repository.js";
import { DrizzleDeletionExecutorRepository } from "../../src/account/deletion-executor-repository.js";
import { runDeletionCron } from "../../src/account/deletion-cron.js";
import type { DeletionExecutorDeps } from "../../src/account/deletion-executor.js";

async function seedTenant(pool: PGlite, tenantId: string): Promise<void> {
  await pool.query(
    `INSERT INTO bot_instances (id, tenant_id, name, billing_state, resource_tier, storage_tier, created_at, updated_at)
     VALUES ($1, $2, 'Bot', 'active', 'standard', 'standard', now()::text, now()::text)`,
    [`bot-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, created_at)
     VALUES ($1, $2, 10000000000, 10000000000, 'signup_grant', now()::text)`,
    [`tx-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO credit_balances (tenant_id, balance_credits, last_updated) VALUES ($1, 10000000000, now()::text)`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp)
     VALUES ($1, $2, 100, 200, 'tts', 'openai', 1700000000)`,
    [`me-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO usage_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, window_start, window_end)
     VALUES ($1, $2, 'tts', 'openai', 1, 100, 200, 1700000000, 1700003600)`,
    [`us-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO billing_period_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, period_start, period_end, updated_at)
     VALUES ($1, $2, 'tts', 'openai', 1, 100, 200, 1700000000, 1700003600, 1700000000)`,
    [`bps-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO tenant_customers (tenant, processor_customer_id, created_at, updated_at)
     VALUES ($1, $2, 1700000000, 1700000000)`,
    [tenantId, `cus_test_${tenantId}`],
  );
  await pool.query(
    `INSERT INTO stripe_usage_reports (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at)
     VALUES ($1, $2, 'tts', 'openai', 1700000000, 1700003600, 'tts_usage', 20, 1700000001)`,
    [`sur-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO notification_queue (id, tenant_id, email_type, recipient_email)
     VALUES ($1, $2, 'low-balance', 'user@example.com')`,
    [`nq-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO notification_preferences (tenant_id) VALUES ($1)`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO email_notifications (id, tenant_id, email_type, sent_date)
     VALUES ($1, $2, 'low-balance', '2026-01-01')`,
    [`en-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type)
     VALUES ($1, 1700000000, $2, 'password', 'login', 'user')`,
    [`al-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO admin_audit_log (id, admin_user, action, category, target_tenant, target_user)
     VALUES ($1, 'admin', 'view', 'account', $2, $3)`,
    [`aal-${tenantId}`, tenantId, tenantId],
  );
  await pool.query(
    `INSERT INTO admin_notes (id, tenant_id, author_id, content) VALUES ($1, $2, 'admin', 'Test note')`,
    [`an-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO snapshots (id, tenant, instance_id, user_id, trigger, storage_path)
     VALUES ($1, $2, 'inst-1', $3, 'manual', '/data/snap')`,
    [`snap-${tenantId}`, tenantId, tenantId],
  );
  await pool.query(
    `INSERT INTO payram_charges (reference_id, tenant_id, amount_usd_cents) VALUES ($1, $2, 500)`,
    [`pc-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO tenant_status (tenant_id) VALUES ($1)`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO user_roles (user_id, tenant_id, role, granted_at) VALUES ($1, $2, 'tenant_admin', 1700000000)`,
    [tenantId, tenantId],
  );
  await pool.query(
    `INSERT INTO backup_status (container_id, node_id) VALUES ($1, 'node-1')`,
    [`tenant_${tenantId}_backup`],
  );
}

async function seedAuthTables(pool: PGlite, tenantId: string): Promise<void> {
  // DDL statements cannot be parameterized — no user input involved
  await pool.exec(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, provider_account_id TEXT NOT NULL);
  `);
  await pool.query(
    `INSERT INTO "user" (id, email) VALUES ($1, $2)`,
    [tenantId, `${tenantId}@example.com`],
  );
  await pool.query(
    `INSERT INTO session (id, user_id, token, expires_at) VALUES ($1, $2, 'tok', '2099-01-01')`,
    [`sess-${tenantId}`, tenantId],
  );
  await pool.query(
    `INSERT INTO account (id, user_id, provider, provider_account_id) VALUES ($1, $2, 'email', $3)`,
    [`acc-${tenantId}`, tenantId, `${tenantId}@example.com`],
  );
}

async function countRows(pool: PGlite, table: string, col: string, val: string): Promise<number> {
  const result = await pool.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = $1`, [val]);
  return Number(result.rows[0]?.c ?? 0);
}

const GDPR_TABLES: Array<{ table: string; col: string }> = [
  { table: "bot_instances", col: "tenant_id" },
  { table: "credit_transactions", col: "tenant_id" },
  { table: "credit_balances", col: "tenant_id" },
  { table: "meter_events", col: "tenant" },
  { table: "usage_summaries", col: "tenant" },
  { table: "billing_period_summaries", col: "tenant" },
  { table: "stripe_usage_reports", col: "tenant" },
  { table: "notification_queue", col: "tenant_id" },
  { table: "notification_preferences", col: "tenant_id" },
  { table: "email_notifications", col: "tenant_id" },
  { table: "audit_log", col: "user_id" },
  { table: "admin_notes", col: "tenant_id" },
  { table: "snapshots", col: "tenant" },
  { table: "payram_charges", col: "tenant_id" },
  { table: "tenant_status", col: "tenant_id" },
  { table: "tenant_customers", col: "tenant" },
  { table: "user_roles", col: "tenant_id" },
];

const AUTH_TABLES: Array<{ table: string; col: string }> = [
  { table: '"user"', col: "id" },
  { table: "session", col: "user_id" },
  { table: "account", col: "user_id" },
];

async function assertRowCounts(
  pool: PGlite,
  tables: Array<{ table: string; col: string }>,
  tenantId: string,
  expected: number,
): Promise<void> {
  for (const { table, col } of tables) {
    expect(await countRows(pool, table, col, tenantId)).toBe(expected);
  }
}

describe("E2E: account deletion GDPR flow", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let store: AccountDeletionStore;
  let executorDeps: DeletionExecutorDeps;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    store = new AccountDeletionStore(new DrizzleDeletionRepository(db));
    executorDeps = { repo: new DrizzleDeletionExecutorRepository(db, pool) };
  });

  afterEach(async () => {
    if (pool) await pool.close();
  });

  it("request → grace period expires → cron purges ALL tenant data", async () => {
    const tenantId = `gdpr-happy-${randomUUID().slice(0, 8)}`;
    await seedTenant(pool, tenantId);
    await seedAuthTables(pool, tenantId);

    // 1. Submit deletion request
    const request = await store.create(tenantId, tenantId);
    expect(request.status).toBe("pending");

    // 2. Cron should NOT process — grace period not expired
    const earlyResult = await runDeletionCron(store, executorDeps);
    expect(earlyResult.processed).toBe(0);

    // 3. Advance clock past grace period (manipulate DB directly)
    await pool.query(
      `UPDATE account_deletion_requests SET delete_after = (now() - interval '1 day')::text WHERE id = $1`,
      [request.id],
    );

    // 4. Run cron — should process and purge
    const cronResult = await runDeletionCron(store, executorDeps);
    expect(cronResult.processed).toBe(1);
    expect(cronResult.succeeded).toBe(1);
    expect(cronResult.results[0]?.errors ?? []).toEqual([]);
    expect(cronResult.failed).toBe(0);

    // 5. Assert ALL tenant data purged
    await assertRowCounts(pool, GDPR_TABLES, tenantId, 0);

    // backup_status uses container_id pattern, not tenant_id directly
    const backupRows = await pool.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM backup_status WHERE container_id LIKE $1`,
      [`%${tenantId}%`],
    );
    expect(Number(backupRows.rows[0]?.c ?? 0)).toBe(0);

    // 6. Assert auth user deleted
    await assertRowCounts(pool, AUTH_TABLES, tenantId, 0);

    // 7. Admin audit log anonymized (not deleted)
    const auditRows = await pool.query<{ target_tenant: string }>(
      `SELECT target_tenant FROM admin_audit_log WHERE id = $1`,
      [`aal-${tenantId}`],
    );
    expect(auditRows.rows[0]?.target_tenant).toBe("[deleted]");

    // 8. Deletion request marked completed
    const completed = await store.getById(request.id);
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBeTruthy();
    expect(completed?.deletionSummary).toBeTruthy();
  });

  it("cron is idempotent — running again after purge produces no error", async () => {
    const tenantId = `gdpr-idempotent-${randomUUID().slice(0, 8)}`;
    await seedTenant(pool, tenantId);
    await seedAuthTables(pool, tenantId);

    // Create and expire request
    const request = await store.create(tenantId, tenantId);
    await pool.query(
      `UPDATE account_deletion_requests SET delete_after = (now() - interval '1 day')::text WHERE id = $1`,
      [request.id],
    );

    // First run — purge
    const first = await runDeletionCron(store, executorDeps);
    expect(first.succeeded).toBe(1);
    expect(first.results[0]?.errors ?? []).toEqual([]);

    // Second run — no pending expired requests, should be a no-op
    const second = await runDeletionCron(store, executorDeps);
    expect(second.processed).toBe(0);
    expect(second.succeeded).toBe(0);
    expect(second.failed).toBe(0);
  });

  it("cancel during grace period → cron skips, all account data intact", async () => {
    const tenantId = `gdpr-cancel-${randomUUID().slice(0, 8)}`;
    await seedTenant(pool, tenantId);

    // Create deletion request (grace period active)
    const request = await store.create(tenantId, tenantId);
    expect(request.status).toBe("pending");

    // Cancel before grace period expires
    await store.cancel(request.id, "User changed their mind");

    // Expire the request (even though cancelled)
    await pool.query(
      `UPDATE account_deletion_requests SET delete_after = (now() - interval '1 day')::text WHERE id = $1`,
      [request.id],
    );

    // Run cron — should NOT process cancelled requests
    const cronResult = await runDeletionCron(store, executorDeps);
    expect(cronResult.processed).toBe(0);

    // Verify all data still intact (spot-check subset)
    await assertRowCounts(pool, GDPR_TABLES, tenantId, 1);

    // Request should be cancelled
    const cancelled = await store.getById(request.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelReason).toBe("User changed their mind");
  });

  it("admin-initiated deletion: grace period bypassed, immediate purge", async () => {
    const tenantId = `gdpr-admin-${randomUUID().slice(0, 8)}`;
    await seedTenant(pool, tenantId);
    await seedAuthTables(pool, tenantId);

    const requestId = randomUUID();

    // Admin inserts deletion request with delete_after = now (already expired)
    await pool.query(
      `
      INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
      VALUES ($1, $2, 'admin-user', 'pending', (now() - interval '1 second')::text)
    `,
      [requestId, tenantId],
    );

    // Run cron immediately — should process since already expired
    const cronResult = await runDeletionCron(store, executorDeps);
    expect(cronResult.processed).toBe(1);
    expect(cronResult.succeeded).toBe(1);
    expect(cronResult.results[0]?.errors ?? []).toEqual([]);

    // All data purged
    await assertRowCounts(pool, GDPR_TABLES, tenantId, 0);

    // Auth user deleted
    await assertRowCounts(pool, AUTH_TABLES.slice(0, 2), tenantId, 0);

    // Request completed
    const completed = await store.getById(requestId);
    expect(completed?.status).toBe("completed");
  });
});
