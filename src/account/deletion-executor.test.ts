import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DrizzleDb } from "../db/index.js";
import { type DeletionExecutorDeps, executeDeletion } from "./deletion-executor.js";

function setupDbs(): { db: DrizzleDb; rawDb: Database.Database; authDb: Database.Database } {
  const rawDb = new Database(":memory:");
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS bot_instances (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      billing_state TEXT NOT NULL DEFAULT 'active',
      suspended_at TEXT,
      destroy_after TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      balance_after_cents INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      reference_id TEXT,
      funding_source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS credit_balances (
      tenant_id TEXT PRIMARY KEY,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS credit_adjustments (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS meter_events (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      cost REAL NOT NULL,
      charge REAL NOT NULL,
      capability TEXT NOT NULL,
      provider TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_summaries (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      capability TEXT NOT NULL,
      provider TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      total_cost REAL NOT NULL,
      total_charge REAL NOT NULL,
      total_duration INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_period_summaries (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      capability TEXT NOT NULL,
      provider TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      total_cost REAL NOT NULL,
      total_charge REAL NOT NULL,
      total_duration INTEGER NOT NULL DEFAULT 0,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenant_customers (
      tenant TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free',
      billing_hold INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS stripe_usage_reports (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      capability TEXT NOT NULL,
      provider TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      value_cents INTEGER NOT NULL,
      reported_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_queue (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      email_type TEXT NOT NULL,
      recipient_email TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_attempt_at INTEGER,
      last_error TEXT,
      retry_after INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      sent_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS notification_preferences (
      tenant_id TEXT PRIMARY KEY,
      billing_low_balance INTEGER NOT NULL DEFAULT 1,
      billing_receipts INTEGER NOT NULL DEFAULT 1,
      billing_auto_topup INTEGER NOT NULL DEFAULT 1,
      agent_channel_disconnect INTEGER NOT NULL DEFAULT 1,
      agent_status_changes INTEGER NOT NULL DEFAULT 0,
      account_role_changes INTEGER NOT NULL DEFAULT 1,
      account_team_invites INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS email_notifications (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      email_type TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      auth_method TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details TEXT,
      ip_address TEXT,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      admin_user TEXT NOT NULL,
      action TEXT NOT NULL,
      category TEXT NOT NULL,
      target_tenant TEXT,
      target_user TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS admin_notes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL DEFAULT '',
      instance_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      type TEXT NOT NULL DEFAULT 'on-demand',
      s3_key TEXT,
      size_mb REAL NOT NULL DEFAULT 0,
      size_bytes INTEGER,
      node_id TEXT,
      trigger TEXT NOT NULL,
      plugins TEXT NOT NULL DEFAULT '[]',
      config_hash TEXT NOT NULL DEFAULT '',
      storage_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at INTEGER,
      deleted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS payram_charges (
      reference_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      amount_usd_cents INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      currency TEXT,
      filled_amount TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      credited_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tenant_status (
      tenant_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      status_reason TEXT,
      status_changed_at INTEGER,
      status_changed_by TEXT,
      grace_deadline TEXT,
      data_delete_after TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      role TEXT NOT NULL,
      granted_by TEXT,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, tenant_id)
    );
    CREATE TABLE IF NOT EXISTS backup_status (
      id TEXT PRIMARY KEY,
      container_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const db = createDb(rawDb);

  const authDb = new Database(":memory:");
  authDb.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  return { db, rawDb, authDb };
}

function seedTenant(rawDb: Database.Database, tenantId: string): void {
  rawDb.exec(`
    INSERT INTO bot_instances (id, tenant_id, name) VALUES ('bot-${tenantId}', '${tenantId}', 'Bot');
    INSERT INTO credit_transactions (id, tenant_id, amount_cents, balance_after_cents, type) VALUES ('tx-${tenantId}', '${tenantId}', 1000, 1000, 'signup_grant');
    INSERT INTO credit_balances (tenant_id, balance_cents) VALUES ('${tenantId}', 1000);
    INSERT INTO credit_adjustments (id, tenant, amount_cents, reason) VALUES ('adj-${tenantId}', '${tenantId}', 500, 'test');
    INSERT INTO meter_events (id, tenant, cost, charge, capability, provider, timestamp) VALUES ('me-${tenantId}', '${tenantId}', 0.1, 0.2, 'tts', 'openai', 1700000000);
    INSERT INTO usage_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, window_start, window_end) VALUES ('us-${tenantId}', '${tenantId}', 'tts', 'openai', 1, 0.1, 0.2, 1700000000, 1700003600);
    INSERT INTO billing_period_summaries (id, tenant, capability, provider, event_count, total_cost, total_charge, period_start, period_end, updated_at) VALUES ('bps-${tenantId}', '${tenantId}', 'tts', 'openai', 1, 0.1, 0.2, 1700000000, 1700003600, 1700000000);
    INSERT INTO tenant_customers (tenant, stripe_customer_id, created_at, updated_at) VALUES ('${tenantId}', 'cus_test_${tenantId}', 1700000000, 1700000000);
    INSERT INTO stripe_usage_reports (id, tenant, capability, provider, period_start, period_end, event_name, value_cents, reported_at) VALUES ('sur-${tenantId}', '${tenantId}', 'tts', 'openai', 1700000000, 1700003600, 'tts_usage', 20, 1700000001);
    INSERT INTO notification_queue (id, tenant_id, email_type, recipient_email) VALUES ('nq-${tenantId}', '${tenantId}', 'low-balance', 'user@example.com');
    INSERT INTO notification_preferences (tenant_id) VALUES ('${tenantId}');
    INSERT INTO email_notifications (id, tenant_id, email_type, sent_date) VALUES ('en-${tenantId}', '${tenantId}', 'low-balance', '2024-01-01');
    INSERT INTO audit_log (id, timestamp, user_id, auth_method, action, resource_type) VALUES ('al-${tenantId}', 1700000000, '${tenantId}', 'password', 'login', 'user');
    INSERT INTO admin_audit_log (id, admin_user, action, category, target_tenant, target_user, created_at) VALUES ('aal-${tenantId}', 'admin', 'view', 'account', '${tenantId}', '${tenantId}', 1700000000);
    INSERT INTO admin_notes (id, tenant_id, author_id, content) VALUES ('an-${tenantId}', '${tenantId}', 'admin', 'Test note');
    INSERT INTO snapshots (id, tenant, instance_id, user_id, trigger, storage_path) VALUES ('snap-${tenantId}', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/snap');
    INSERT INTO payram_charges (reference_id, tenant_id, amount_usd_cents) VALUES ('pc-${tenantId}', '${tenantId}', 500);
    INSERT INTO tenant_status (tenant_id) VALUES ('${tenantId}');
    INSERT INTO user_roles (user_id, tenant_id, role, granted_at) VALUES ('${tenantId}', '${tenantId}', 'tenant_admin', 1700000000);
    INSERT INTO backup_status (id, container_id) VALUES ('bs-${tenantId}', 'tenant_${tenantId}_backup');
  `);
}

function seedAuthUser(authDb: Database.Database, userId: string): void {
  authDb.exec(`
    INSERT INTO user (id, email) VALUES ('${userId}', 'user@example.com');
    INSERT INTO session (id, user_id, token, expires_at) VALUES ('sess-${userId}', '${userId}', 'tok', '2099-01-01');
    INSERT INTO account (id, user_id, provider, provider_account_id) VALUES ('acc-${userId}', '${userId}', 'email', 'user@example.com');
    INSERT INTO email_verification_tokens (id, user_id, token, expires_at) VALUES ('evt-${userId}', '${userId}', 'tok2', '2099-01-01');
  `);
}

describe("executeDeletion", () => {
  let db: DrizzleDb;
  let rawDb: Database.Database;
  let authDb: Database.Database;
  let deps: DeletionExecutorDeps;

  beforeEach(() => {
    ({ db, rawDb, authDb } = setupDbs());
    deps = { db, rawDb, authDb };
  });

  describe("full purge", () => {
    it("deletes all tenant data and reports accurate counts", async () => {
      const tenantId = "tenant-a";
      seedTenant(rawDb, tenantId);

      const result = await executeDeletion(deps, tenantId);

      expect(result.tenantId).toBe(tenantId);
      expect(result.errors).toHaveLength(0);

      // Verify rows are deleted
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM bot_instances WHERE tenant_id = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM credit_transactions WHERE tenant_id = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM credit_balances WHERE tenant_id = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM credit_adjustments WHERE tenant = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM meter_events WHERE tenant = ?").get(tenantId)).toEqual({ c: 0 });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM usage_summaries WHERE tenant = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(
        rawDb.prepare("SELECT COUNT(*) AS c FROM billing_period_summaries WHERE tenant = ?").get(tenantId),
      ).toEqual({ c: 0 });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM stripe_usage_reports WHERE tenant = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM notification_queue WHERE tenant_id = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(
        rawDb.prepare("SELECT COUNT(*) AS c FROM notification_preferences WHERE tenant_id = ?").get(tenantId),
      ).toEqual({ c: 0 });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM email_notifications WHERE tenant_id = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE user_id = ?").get(tenantId)).toEqual({ c: 0 });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM admin_notes WHERE tenant_id = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM snapshots WHERE tenant = ?").get(tenantId)).toEqual({ c: 0 });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM payram_charges WHERE tenant_id = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM tenant_status WHERE tenant_id = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM tenant_customers WHERE tenant = ?").get(tenantId)).toEqual({
        c: 0,
      });
    });
  });

  describe("data isolation", () => {
    it("leaves other tenants' data intact", async () => {
      seedTenant(rawDb, "tenant-a");
      seedTenant(rawDb, "tenant-b");

      await executeDeletion(deps, "tenant-a");

      // tenant-b should still have all its data
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM bot_instances WHERE tenant_id = ?").get("tenant-b")).toEqual({
        c: 1,
      });
      expect(
        rawDb.prepare("SELECT COUNT(*) AS c FROM credit_transactions WHERE tenant_id = ?").get("tenant-b"),
      ).toEqual({ c: 1 });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM tenant_customers WHERE tenant = ?").get("tenant-b")).toEqual({
        c: 1,
      });
    });
  });

  describe("Stripe deletion", () => {
    it("calls stripe.customers.del with the correct customer ID", async () => {
      const tenantId = "tenant-stripe";
      seedTenant(rawDb, tenantId);

      const mockStripe = { customers: { del: vi.fn().mockResolvedValue({}) } };
      const mockTenantStore = {
        getByTenant: vi.fn().mockReturnValue({ stripe_customer_id: "cus_test_tenant-stripe" }),
      };

      await executeDeletion({ ...deps, stripe: mockStripe as never, tenantStore: mockTenantStore as never }, tenantId);

      expect(mockStripe.customers.del).toHaveBeenCalledWith("cus_test_tenant-stripe");
    });

    it("continues purge even if Stripe deletion fails", async () => {
      const tenantId = "tenant-stripe-fail";
      seedTenant(rawDb, tenantId);

      const mockStripe = {
        customers: { del: vi.fn().mockRejectedValue(new Error("Stripe error: customer has open invoices")) },
      };
      const mockTenantStore = { getByTenant: vi.fn().mockReturnValue({ stripe_customer_id: "cus_fail" }) };

      const result = await executeDeletion(
        { ...deps, stripe: mockStripe as never, tenantStore: mockTenantStore as never },
        tenantId,
      );

      // Stripe error recorded but purge continues
      expect(result.errors.some((e) => e.includes("stripe_customer"))).toBe(true);
      // Other data still deleted
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM bot_instances WHERE tenant_id = ?").get(tenantId)).toEqual({
        c: 0,
      });
    });
  });

  describe("auth user deletion", () => {
    it("deletes user, sessions, accounts, and verification tokens from auth DB", async () => {
      const tenantId = "tenant-auth";
      seedTenant(rawDb, tenantId);
      seedAuthUser(authDb, tenantId);

      const result = await executeDeletion(deps, tenantId);

      expect(result.authUserDeleted).toBe(true);
      expect(authDb.prepare("SELECT COUNT(*) AS c FROM user WHERE id = ?").get(tenantId)).toEqual({ c: 0 });
      expect(authDb.prepare("SELECT COUNT(*) AS c FROM session WHERE user_id = ?").get(tenantId)).toEqual({ c: 0 });
      expect(authDb.prepare("SELECT COUNT(*) AS c FROM account WHERE user_id = ?").get(tenantId)).toEqual({ c: 0 });
      expect(
        authDb.prepare("SELECT COUNT(*) AS c FROM email_verification_tokens WHERE user_id = ?").get(tenantId),
      ).toEqual({ c: 0 });
    });

    it("succeeds without auth deletion when authDb is undefined", async () => {
      const tenantId = "tenant-no-auth";
      seedTenant(rawDb, tenantId);

      const result = await executeDeletion({ db, rawDb }, tenantId);

      expect(result.authUserDeleted).toBe(false);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("admin audit log anonymization", () => {
    it("anonymizes admin_audit_log rows instead of deleting them", async () => {
      const tenantId = "tenant-audit";
      seedTenant(rawDb, tenantId);

      await executeDeletion(deps, tenantId);

      const row = rawDb
        .prepare("SELECT target_tenant, target_user FROM admin_audit_log WHERE id = ?")
        .get(`aal-${tenantId}`) as
        | {
            target_tenant: string;
            target_user: string;
          }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.target_tenant).toBe("[deleted]");
      expect(row?.target_user).toBe("[deleted]");
    });
  });

  describe("credit_adjustments raw SQL table", () => {
    it("deletes credit_adjustments rows for the tenant", async () => {
      const tenantId = "tenant-adj";
      seedTenant(rawDb, tenantId);

      await executeDeletion(deps, tenantId);

      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM credit_adjustments WHERE tenant = ?").get(tenantId)).toEqual({
        c: 0,
      });
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM credit_adjustments").get()).toEqual({ c: 0 });
    });
  });

  describe("S3 snapshot object deletion", () => {
    it("deletes S3 objects for snapshots with s3_key before deleting DB rows", async () => {
      const tenantId = "tenant-s3";
      seedTenant(rawDb, tenantId);
      // The seedTenant inserts a snapshot without s3_key. Add one with an s3_key.
      rawDb.exec(`
        INSERT INTO snapshots (id, tenant, instance_id, user_id, trigger, storage_path, s3_key)
        VALUES ('snap-s3-1', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/snap', 'on-demand/${tenantId}/snap-s3-1.tar.gz')
      `);

      const mockSpaces = { remove: vi.fn().mockResolvedValue(undefined) };
      const result = await executeDeletion({ ...deps, spaces: mockSpaces }, tenantId);

      // Should have called remove for the snapshot with s3_key (snap-s3-1), not for snap-tenant-s3 (no s3_key)
      expect(mockSpaces.remove).toHaveBeenCalledTimes(1);
      expect(mockSpaces.remove).toHaveBeenCalledWith(`on-demand/${tenantId}/snap-s3-1.tar.gz`);
      // DB rows should still be deleted
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM snapshots WHERE tenant = ?").get(tenantId)).toEqual({ c: 0 });
      expect(result.errors).toHaveLength(0);
      expect(result.deletedCounts["s3_object:snap-s3-1"]).toBe(1);
    });

    it("handles multiple snapshots — some with s3_key, some without", async () => {
      const tenantId = "tenant-multi-s3";
      // Don't use seedTenant here — insert snapshots manually for precise control
      rawDb.exec(`
        INSERT INTO snapshots (id, tenant, instance_id, user_id, trigger, storage_path, s3_key)
        VALUES
          ('snap-a', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/a', 'on-demand/${tenantId}/a.tar.gz'),
          ('snap-b', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/b', NULL),
          ('snap-c', '${tenantId}', 'inst-2', '${tenantId}', 'scheduled', '/data/c', 'nightly/node1/${tenantId}/c.tar.gz')
      `);

      const mockSpaces = { remove: vi.fn().mockResolvedValue(undefined) };
      const result = await executeDeletion({ ...deps, spaces: mockSpaces }, tenantId);

      // Should call remove for snap-a and snap-c (both have s3_key), skip snap-b
      expect(mockSpaces.remove).toHaveBeenCalledTimes(2);
      expect(mockSpaces.remove).toHaveBeenCalledWith(`on-demand/${tenantId}/a.tar.gz`);
      expect(mockSpaces.remove).toHaveBeenCalledWith(`nightly/node1/${tenantId}/c.tar.gz`);
      expect(result.deletedCounts["s3_object:snap-a"]).toBe(1);
      expect(result.deletedCounts["s3_object:snap-c"]).toBe(1);
      // All DB rows deleted
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM snapshots WHERE tenant = ?").get(tenantId)).toEqual({ c: 0 });
    });

    it("logs S3 deletion failure to errors but continues deletion", async () => {
      const tenantId = "tenant-s3-fail";
      rawDb.exec(`
        INSERT INTO snapshots (id, tenant, instance_id, user_id, trigger, storage_path, s3_key)
        VALUES
          ('snap-fail', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/fail', 'on-demand/${tenantId}/fail.tar.gz'),
          ('snap-ok', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/ok', 'on-demand/${tenantId}/ok.tar.gz')
      `);

      const mockSpaces = {
        remove: vi.fn().mockRejectedValueOnce(new Error("S3 connection timeout")).mockResolvedValueOnce(undefined),
      };
      const result = await executeDeletion({ ...deps, spaces: mockSpaces }, tenantId);

      // First call fails, second succeeds
      expect(mockSpaces.remove).toHaveBeenCalledTimes(2);
      // Error is logged for the failed one
      expect(result.errors.some((e) => e.includes("s3_snapshot(snap-fail)"))).toBe(true);
      expect(result.errors.some((e) => e.includes("S3 connection timeout"))).toBe(true);
      // Successful one is tracked
      expect(result.deletedCounts["s3_object:snap-ok"]).toBe(1);
      // DB rows are still deleted despite S3 failure
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM snapshots WHERE tenant = ?").get(tenantId)).toEqual({ c: 0 });
    });

    it("skips S3 deletion when spaces dependency is not provided", async () => {
      const tenantId = "tenant-no-spaces";
      rawDb.exec(`
        INSERT INTO snapshots (id, tenant, instance_id, user_id, trigger, storage_path, s3_key)
        VALUES ('snap-nospaces', '${tenantId}', 'inst-1', '${tenantId}', 'manual', '/data/snap', 'on-demand/${tenantId}/snap.tar.gz')
      `);

      // No spaces in deps
      const result = await executeDeletion(deps, tenantId);

      // DB rows still deleted, no S3 errors
      expect(rawDb.prepare("SELECT COUNT(*) AS c FROM snapshots WHERE tenant = ?").get(tenantId)).toEqual({ c: 0 });
      expect(result.errors).toHaveLength(0);
    });

    it("handles tenant with no snapshots gracefully", async () => {
      const tenantId = "tenant-no-snaps";
      // No snapshots inserted for this tenant

      const mockSpaces = { remove: vi.fn() };
      const result = await executeDeletion({ ...deps, spaces: mockSpaces }, tenantId);

      expect(mockSpaces.remove).not.toHaveBeenCalled();
      expect(result.errors).toHaveLength(0);
    });
  });
});
