import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/index.js";
import { runDeletionCron } from "./deletion-cron.js";
import type { DeletionExecutorDeps } from "./deletion-executor.js";
import { DrizzleDeletionExecutorRepository } from "./deletion-executor-repository.js";
import { DrizzleDeletionRepository } from "./deletion-repository.js";
import { AccountDeletionStore } from "./deletion-store.js";

function setupStore(): { store: AccountDeletionStore; sqlite: Database.Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE account_deletion_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      delete_after TEXT NOT NULL,
      cancel_reason TEXT,
      completed_at TEXT,
      deletion_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by_user_id TEXT
    );
    CREATE TABLE bot_instances (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, billing_state TEXT NOT NULL DEFAULT 'active', suspended_at TEXT, destroy_after TEXT, storage_tier TEXT NOT NULL DEFAULT 'standard', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE credit_transactions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, balance_after_cents INTEGER NOT NULL, type TEXT NOT NULL, description TEXT, reference_id TEXT, funding_source TEXT,
      attributed_user_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE credit_balances (tenant_id TEXT PRIMARY KEY, balance_cents INTEGER NOT NULL DEFAULT 0, last_updated TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meter_events (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, cost REAL NOT NULL, charge REAL NOT NULL, capability TEXT NOT NULL, provider TEXT NOT NULL, timestamp INTEGER NOT NULL);
    CREATE TABLE usage_summaries (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, capability TEXT NOT NULL, provider TEXT NOT NULL, event_count INTEGER NOT NULL, total_cost REAL NOT NULL, total_charge REAL NOT NULL, total_duration INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL, window_end INTEGER NOT NULL);
    CREATE TABLE billing_period_summaries (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, capability TEXT NOT NULL, provider TEXT NOT NULL, event_count INTEGER NOT NULL, total_cost REAL NOT NULL, total_charge REAL NOT NULL, total_duration INTEGER NOT NULL DEFAULT 0, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE tenant_customers (tenant TEXT PRIMARY KEY, processor_customer_id TEXT NOT NULL, processor TEXT NOT NULL DEFAULT 'stripe', tier TEXT NOT NULL DEFAULT 'free', billing_hold INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE stripe_usage_reports (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, capability TEXT NOT NULL, provider TEXT NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, event_name TEXT NOT NULL, value_cents INTEGER NOT NULL, reported_at INTEGER NOT NULL);
    CREATE TABLE notification_queue (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email_type TEXT NOT NULL, recipient_email TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, last_attempt_at INTEGER, last_error TEXT, retry_after INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), sent_at INTEGER);
    CREATE TABLE notification_preferences (tenant_id TEXT PRIMARY KEY, billing_low_balance INTEGER NOT NULL DEFAULT 1, billing_receipts INTEGER NOT NULL DEFAULT 1, billing_auto_topup INTEGER NOT NULL DEFAULT 1, agent_channel_disconnect INTEGER NOT NULL DEFAULT 1, agent_status_changes INTEGER NOT NULL DEFAULT 0, account_role_changes INTEGER NOT NULL DEFAULT 1, account_team_invites INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE email_notifications (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email_type TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT (datetime('now')), sent_date TEXT NOT NULL);
    CREATE TABLE audit_log (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, user_id TEXT NOT NULL, auth_method TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, details TEXT, ip_address TEXT, user_agent TEXT);
    CREATE TABLE admin_audit_log (id TEXT PRIMARY KEY, admin_user TEXT NOT NULL, action TEXT NOT NULL, category TEXT NOT NULL, target_tenant TEXT, target_user TEXT, details TEXT NOT NULL DEFAULT '{}', ip_address TEXT, user_agent TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE admin_notes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, author_id TEXT NOT NULL, content TEXT NOT NULL, is_pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE snapshots (id TEXT PRIMARY KEY, tenant TEXT NOT NULL DEFAULT '', instance_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, type TEXT NOT NULL DEFAULT 'on-demand', s3_key TEXT, size_mb REAL NOT NULL DEFAULT 0, size_bytes INTEGER, node_id TEXT, trigger TEXT NOT NULL, plugins TEXT NOT NULL DEFAULT '[]', config_hash TEXT NOT NULL DEFAULT '', storage_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at INTEGER, deleted_at INTEGER);
    CREATE TABLE payram_charges (reference_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, amount_usd_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', currency TEXT, filled_amount TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), credited_at TEXT);
    CREATE TABLE tenant_status (tenant_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', status_reason TEXT, status_changed_at INTEGER, status_changed_by TEXT, grace_deadline TEXT, data_delete_after TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE user_roles (user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, role TEXT NOT NULL, granted_by TEXT, granted_at INTEGER NOT NULL, PRIMARY KEY (user_id, tenant_id));
  `);
  const db = createDb(sqlite);
  const repo = new DrizzleDeletionRepository(db);
  const store = new AccountDeletionStore(repo);
  return { store, sqlite };
}

describe("runDeletionCron", () => {
  let store: AccountDeletionStore;
  let sqlite: Database.Database;
  let executorDeps: DeletionExecutorDeps;

  beforeEach(() => {
    ({ store, sqlite } = setupStore());
    const db = createDb(sqlite);
    const repo = new DrizzleDeletionExecutorRepository(db, sqlite);
    executorDeps = { repo };
  });

  it("processes expired requests and marks them completed", async () => {
    // Insert an already-expired request directly
    sqlite.exec(`
      INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
      VALUES ('expired-1', 'tenant-exp-1', 'user-1', 'pending', datetime('now', '-1 day'))
    `);

    const cronResult = await runDeletionCron(store, executorDeps);

    expect(cronResult.processed).toBeGreaterThanOrEqual(1);
    expect(cronResult.succeeded).toBeGreaterThanOrEqual(1);
    expect(cronResult.failed).toBe(0);

    const updated = store.getById("expired-1");
    expect(updated?.status).toBe("completed");
    expect(updated?.completedAt).toBeTruthy();
  });

  it("skips non-expired pending requests", async () => {
    const req = store.create("tenant-future", "user-future");

    const cronResult = await runDeletionCron(store, executorDeps);

    expect(cronResult.processed).toBe(0);
    const still = store.getById(req.id);
    expect(still?.status).toBe("pending");
  });

  it("skips cancelled requests even if deleteAfter is in the past", async () => {
    sqlite.exec(`
      INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
      VALUES ('cancelled-old', 'tenant-c', 'user-c', 'cancelled', datetime('now', '-1 day'))
    `);

    const cronResult = await runDeletionCron(store, executorDeps);

    expect(cronResult.processed).toBe(0);
    const req = store.getById("cancelled-old");
    expect(req?.status).toBe("cancelled");
  });

  it("continues processing and reports failures when an executor error occurs", async () => {
    sqlite.exec(`
      INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
      VALUES ('expired-err', 'tenant-err', 'user-err', 'pending', datetime('now', '-1 day'))
    `);

    // Mock executeDeletion to throw
    const mockExecute = vi.fn().mockRejectedValue(new Error("Executor blew up"));

    const { runDeletionCronWithExecutor } = await import("./deletion-cron.js");
    const cronResult = await runDeletionCronWithExecutor(store, executorDeps, mockExecute);

    expect(cronResult.processed).toBeGreaterThanOrEqual(1);
    expect(cronResult.failed).toBeGreaterThanOrEqual(1);
    expect(cronResult.succeeded).toBe(0);
  });
});
