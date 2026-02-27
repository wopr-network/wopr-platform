import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { type DeletionExecutorDeps, executeDeletion } from "./deletion-executor.js";
import { DrizzleDeletionExecutorRepository } from "./deletion-executor-repository.js";

async function seedTenant(pool: PGlite, tenantId: string): Promise<void> {
  await pool.exec(`
    INSERT INTO bot_instances (id, tenant_id, name, billing_state, resource_tier, storage_tier, created_at, updated_at)
    VALUES ('bot-${tenantId}', '${tenantId}', 'Bot', 'active', 'standard', 'standard', now()::text, now()::text);
    INSERT INTO credit_transactions (id, tenant_id, amount_credits, balance_after_credits, type, created_at)
    VALUES ('tx-${tenantId}', '${tenantId}', 10000000000, 10000000000, 'signup_grant', now()::text);
    INSERT INTO credit_balances (tenant_id, balance_credits, last_updated)
    VALUES ('${tenantId}', 10000000000, now()::text);
    INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp)
    VALUES ('me-${tenantId}', '${tenantId}', 100, 200, 'tts', 'openai', 1700000000);
    INSERT INTO usage_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, window_start, window_end)
    VALUES ('us-${tenantId}', '${tenantId}', 'tts', 'openai', 1, 100, 200, 1700000000, 1700003600);
    INSERT INTO billing_period_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, period_start, period_end, updated_at)
    VALUES ('bps-${tenantId}', '${tenantId}', 'tts', 'openai', 1, 100, 200, 1700000000, 1700003600, 1700000000);
    INSERT INTO tenant_customers (tenant, processor_customer_id, created_at, updated_at)
    VALUES ('${tenantId}', 'cus_test_${tenantId}', 1700000000, 1700000000);
    INSERT INTO stripe_usage_reports (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at)
    VALUES ('sur-${tenantId}', '${tenantId}', 'tts', 'openai', 1700000000, 1700003600, 'tts_usage', 20, 1700000001);
    INSERT INTO notification_queue (id, tenant_id, email_type, recipient_email)
    VALUES ('nq-${tenantId}', '${tenantId}', 'low-balance', 'user@example.com');
    INSERT INTO notification_preferences (tenant_id)
    VALUES ('${tenantId}');
    INSERT INTO email_notifications (id, tenant_id, email_type, sent_date)
    VALUES ('en-${tenantId}', '${tenantId}', 'low-balance', '2024-01-01');
    INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type)
    VALUES ('al-${tenantId}', 1700000000, '${tenantId}', 'password', 'login', 'user');
    INSERT INTO admin_audit_log (id, admin_user, action, category, target_tenant, target_user)
    VALUES ('aal-${tenantId}', 'admin', 'view', 'account', '${tenantId}', '${tenantId}');
    INSERT INTO admin_notes (id, tenant_id, author_id, content)
    VALUES ('an-${tenantId}', '${tenantId}', 'admin', 'Test note');
    INSERT INTO snapshots (id, tenant, instance_id, user_id, trigger, storage_path)
    VALUES ('snap-${tenantId}', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/snap');
    INSERT INTO payram_charges (reference_id, tenant_id, amount_usd_cents)
    VALUES ('pc-${tenantId}', '${tenantId}', 500);
    INSERT INTO tenant_status (tenant_id)
    VALUES ('${tenantId}');
    INSERT INTO user_roles (user_id, tenant_id, role, granted_at)
    VALUES ('${tenantId}', '${tenantId}', 'tenant_admin', 1700000000);
    INSERT INTO backup_status (container_id, node_id)
    VALUES ('tenant_${tenantId}_backup', 'node-1');
  `);
}

async function countRows(pool: PGlite, table: string, col: string, val: string): Promise<number> {
  const result = await pool.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = $1`, [val]);
  return Number(result.rows[0]?.c ?? 0);
}

describe("executeDeletion", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let deps: DeletionExecutorDeps;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    const repo = new DrizzleDeletionExecutorRepository(db);
    deps = { repo };
  });

  describe("full purge", () => {
    it("deletes all tenant data and reports accurate counts", async () => {
      const tenantId = "tenant-a";
      await seedTenant(pool, tenantId);

      const result = await executeDeletion(deps, tenantId);

      expect(result.tenantId).toBe(tenantId);
      expect(result.errors).toHaveLength(0);

      // Verify rows are deleted
      expect(await countRows(pool, "bot_instances", "tenant_id", tenantId)).toBe(0);
      expect(await countRows(pool, "credit_transactions", "tenant_id", tenantId)).toBe(0);
      expect(await countRows(pool, "credit_balances", "tenant_id", tenantId)).toBe(0);
      expect(await countRows(pool, "meter_events", "tenant", tenantId)).toBe(0);
      expect(await countRows(pool, "usage_summaries", "tenant", tenantId)).toBe(0);
      expect(await countRows(pool, "billing_period_summaries", "tenant", tenantId)).toBe(0);
      expect(await countRows(pool, "stripe_usage_reports", "tenant", tenantId)).toBe(0);
      expect(await countRows(pool, "notification_queue", "tenant_id", tenantId)).toBe(0);
      expect(await countRows(pool, "notification_preferences", "tenant_id", tenantId)).toBe(0);
      expect(await countRows(pool, "email_notifications", "tenant_id", tenantId)).toBe(0);
      expect(await countRows(pool, "audit_log", "user_id", tenantId)).toBe(0);
      expect(await countRows(pool, "admin_notes", "tenant_id", tenantId)).toBe(0);
      expect(await countRows(pool, "snapshots", "tenant", tenantId)).toBe(0);
      expect(await countRows(pool, "payram_charges", "tenant_id", tenantId)).toBe(0);
      expect(await countRows(pool, "tenant_status", "tenant_id", tenantId)).toBe(0);
      expect(await countRows(pool, "tenant_customers", "tenant", tenantId)).toBe(0);
    });
  });

  describe("data isolation", () => {
    it("leaves other tenants' data intact", async () => {
      await seedTenant(pool, "tenant-a");
      await seedTenant(pool, "tenant-b");

      await executeDeletion(deps, "tenant-a");

      expect(await countRows(pool, "bot_instances", "tenant_id", "tenant-b")).toBe(1);
      expect(await countRows(pool, "credit_transactions", "tenant_id", "tenant-b")).toBe(1);
      expect(await countRows(pool, "tenant_customers", "tenant", "tenant-b")).toBe(1);
    });
  });

  describe("Stripe deletion", () => {
    it("calls stripe.customers.del with the correct customer ID", async () => {
      const tenantId = "tenant-stripe";
      await seedTenant(pool, tenantId);

      const mockStripe = { customers: { del: vi.fn().mockResolvedValue({}) } };
      const mockTenantStore = {
        getByTenant: vi.fn().mockReturnValue({ processor_customer_id: "cus_test_tenant-stripe" }),
      };

      await executeDeletion({ ...deps, stripe: mockStripe as never, tenantStore: mockTenantStore as never }, tenantId);

      expect(mockStripe.customers.del).toHaveBeenCalledWith("cus_test_tenant-stripe");
    });

    it("continues purge even if Stripe deletion fails", async () => {
      const tenantId = "tenant-stripe-fail";
      await seedTenant(pool, tenantId);

      const mockStripe = {
        customers: {
          del: vi.fn().mockRejectedValue(new Error("Stripe error: customer has open invoices")),
        },
      };
      const mockTenantStore = {
        getByTenant: vi.fn().mockReturnValue({ processor_customer_id: "cus_fail" }),
      };

      const result = await executeDeletion(
        { ...deps, stripe: mockStripe as never, tenantStore: mockTenantStore as never },
        tenantId,
      );

      // Stripe error recorded but purge continues
      expect(result.errors.some((e) => e.includes("stripe_customer"))).toBe(true);
      // Other data still deleted
      expect(await countRows(pool, "bot_instances", "tenant_id", tenantId)).toBe(0);
    });
  });

  describe("auth user deletion", () => {
    it("deletes user, sessions, accounts, and verification tokens from auth DB", async () => {
      const tenantId = "tenant-auth";
      await seedTenant(pool, tenantId);

      // Use the same pool as auth DB (tables are in the migration)
      await pool.exec(`
        CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, provider_account_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS email_verification_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL, expires_at TEXT NOT NULL);
        INSERT INTO "user" (id, email) VALUES ('${tenantId}', 'user@example.com');
        INSERT INTO session (id, user_id, token, expires_at) VALUES ('sess-${tenantId}', '${tenantId}', 'tok', '2099-01-01');
        INSERT INTO account (id, user_id, provider, provider_account_id) VALUES ('acc-${tenantId}', '${tenantId}', 'email', 'user@example.com');
        INSERT INTO email_verification_tokens (id, user_id, token, expires_at) VALUES ('evt-${tenantId}', '${tenantId}', 'tok2', '2099-01-01');
      `);

      const repoWithAuth = new DrizzleDeletionExecutorRepository(db, pool);
      const result = await executeDeletion({ repo: repoWithAuth }, tenantId);

      expect(result.authUserDeleted).toBe(true);
      expect(await countRows(pool, '"user"', "id", tenantId)).toBe(0);
      expect(await countRows(pool, "session", "user_id", tenantId)).toBe(0);
      expect(await countRows(pool, "account", "user_id", tenantId)).toBe(0);
      expect(await countRows(pool, "email_verification_tokens", "user_id", tenantId)).toBe(0);
    });

    it("succeeds without auth deletion when authDb is undefined", async () => {
      const tenantId = "tenant-no-auth";
      await seedTenant(pool, tenantId);

      const repoNoAuth = new DrizzleDeletionExecutorRepository(db);
      const result = await executeDeletion({ repo: repoNoAuth }, tenantId);

      expect(result.authUserDeleted).toBe(false);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("admin audit log anonymization", () => {
    it("anonymizes admin_audit_log rows instead of deleting them", async () => {
      const tenantId = "tenant-audit";
      await seedTenant(pool, tenantId);

      await executeDeletion(deps, tenantId);

      const rows = await pool.query<{ target_tenant: string; target_user: string }>(
        `SELECT target_tenant, target_user FROM admin_audit_log WHERE id = $1`,
        [`aal-${tenantId}`],
      );
      expect(rows.rows[0]).toBeDefined();
      expect(rows.rows[0]?.target_tenant).toBe("[deleted]");
      expect(rows.rows[0]?.target_user).toBe("[deleted]");
    });
  });

  describe("S3 snapshot object deletion", () => {
    it("deletes S3 objects for snapshots with s3_key before deleting DB rows", async () => {
      const tenantId = "tenant-s3";
      await seedTenant(pool, tenantId);
      await pool.query(`
        INSERT INTO snapshots (id, tenant, instance_id, user_id, trigger, storage_path, s3_key)
        VALUES ('snap-s3-1', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/snap', 'on-demand/${tenantId}/snap-s3-1.tar.gz')
      `);

      const mockSpaces = { remove: vi.fn().mockResolvedValue(undefined) };
      const result = await executeDeletion({ ...deps, spaces: mockSpaces }, tenantId);

      expect(mockSpaces.remove).toHaveBeenCalledTimes(1);
      expect(mockSpaces.remove).toHaveBeenCalledWith(`on-demand/${tenantId}/snap-s3-1.tar.gz`);
      expect(await countRows(pool, "snapshots", "tenant", tenantId)).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.deletedCounts[`s3_object:snap-s3-1`]).toBe(1);
    });

    it("handles multiple snapshots — some with s3_key, some without", async () => {
      const tenantId = "tenant-multi-s3";
      await pool.query(`
        INSERT INTO snapshots (id, tenant, instance_id, user_id, trigger, storage_path, s3_key)
        VALUES
          ('snap-a', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/a', 'on-demand/${tenantId}/a.tar.gz'),
          ('snap-b', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/b', NULL),
          ('snap-c', '${tenantId}', 'inst-2', '${tenantId}', 'scheduled', '/data/c', 'nightly/node1/${tenantId}/c.tar.gz')
      `);

      const mockSpaces = { remove: vi.fn().mockResolvedValue(undefined) };
      const result = await executeDeletion({ ...deps, spaces: mockSpaces }, tenantId);

      expect(mockSpaces.remove).toHaveBeenCalledTimes(2);
      expect(mockSpaces.remove).toHaveBeenCalledWith(`on-demand/${tenantId}/a.tar.gz`);
      expect(mockSpaces.remove).toHaveBeenCalledWith(`nightly/node1/${tenantId}/c.tar.gz`);
      expect(result.deletedCounts[`s3_object:snap-a`]).toBe(1);
      expect(result.deletedCounts[`s3_object:snap-c`]).toBe(1);
      expect(await countRows(pool, "snapshots", "tenant", tenantId)).toBe(0);
    });

    it("logs S3 deletion failure to errors but continues deletion", async () => {
      const tenantId = "tenant-s3-fail";
      await pool.query(`
        INSERT INTO snapshots (id, tenant, instance_id, user_id, trigger, storage_path, s3_key)
        VALUES
          ('snap-fail', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/fail', 'on-demand/${tenantId}/fail.tar.gz'),
          ('snap-ok', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/ok', 'on-demand/${tenantId}/ok.tar.gz')
      `);

      const mockSpaces = {
        remove: vi.fn().mockRejectedValueOnce(new Error("S3 connection timeout")).mockResolvedValueOnce(undefined),
      };
      const result = await executeDeletion({ ...deps, spaces: mockSpaces }, tenantId);

      expect(mockSpaces.remove).toHaveBeenCalledTimes(2);
      expect(result.errors.some((e) => e.includes("s3_snapshot(snap-fail)"))).toBe(true);
      expect(result.errors.some((e) => e.includes("S3 connection timeout"))).toBe(true);
      expect(result.deletedCounts[`s3_object:snap-ok`]).toBe(1);
      expect(await countRows(pool, "snapshots", "tenant", tenantId)).toBe(0);
    });

    it("skips S3 deletion when spaces dependency is not provided", async () => {
      const tenantId = "tenant-no-spaces";
      await pool.query(`
        INSERT INTO snapshots (id, tenant, instance_id, user_id, trigger, storage_path, s3_key)
        VALUES ('snap-nospaces', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/snap', 'on-demand/${tenantId}/snap.tar.gz')
      `);

      const result = await executeDeletion(deps, tenantId);

      expect(await countRows(pool, "snapshots", "tenant", tenantId)).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("handles tenant with no snapshots gracefully", async () => {
      const tenantId = "tenant-no-snaps";
      const mockSpaces = { remove: vi.fn() };
      const result = await executeDeletion({ ...deps, spaces: mockSpaces }, tenantId);

      expect(mockSpaces.remove).not.toHaveBeenCalled();
      expect(result.errors).toHaveLength(0);
    });
  });
});
