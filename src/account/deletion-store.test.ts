import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../db/index.js";
import { AccountDeletionStore, DELETION_GRACE_DAYS } from "./deletion-store.js";

function setupDb(): { db: DrizzleDb; sqlite: Database.Database } {
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_acct_del_tenant ON account_deletion_requests(tenant_id);
    CREATE INDEX idx_acct_del_status ON account_deletion_requests(status);
    CREATE INDEX idx_acct_del_delete_after ON account_deletion_requests(status, delete_after);
  `);
  const db = createDb(sqlite);
  return { db, sqlite };
}

describe("AccountDeletionStore", () => {
  let db: DrizzleDb;
  let sqlite: Database.Database;
  let store: AccountDeletionStore;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
    store = new AccountDeletionStore(db);
  });

  describe("create()", () => {
    it("creates a pending request with correct initial state", () => {
      const req = store.create("tenant-1", "user-1");
      expect(req.id).toBeTruthy();
      expect(req.tenantId).toBe("tenant-1");
      expect(req.requestedBy).toBe("user-1");
      expect(req.status).toBe("pending");
      expect(req.cancelReason).toBeNull();
      expect(req.completedAt).toBeNull();
    });

    it("sets deleteAfter approximately 30 days from now", () => {
      const req = store.create("tenant-1", "user-1");
      const deleteAfter = new Date(req.deleteAfter);
      const now = new Date();
      const diffDays = (deleteAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      // Allow ±1 day for test timing
      expect(diffDays).toBeGreaterThan(DELETION_GRACE_DAYS - 1);
      expect(diffDays).toBeLessThan(DELETION_GRACE_DAYS + 1);
    });

    it("second request for same tenant works if first was cancelled", () => {
      const req1 = store.create("tenant-1", "user-1");
      store.cancel(req1.id, "Changed my mind");
      const req2 = store.create("tenant-1", "user-1");
      expect(req2.id).not.toBe(req1.id);
      expect(req2.status).toBe("pending");
    });
  });

  describe("getById()", () => {
    it("returns the request by ID", () => {
      const req = store.create("tenant-1", "user-1");
      const found = store.getById(req.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(req.id);
    });

    it("returns null for nonexistent ID", () => {
      const result = store.getById("nonexistent-uuid");
      expect(result).toBeNull();
    });
  });

  describe("getPendingForTenant()", () => {
    it("returns pending request for the tenant", () => {
      store.create("tenant-1", "user-1");
      const found = store.getPendingForTenant("tenant-1");
      expect(found).not.toBeNull();
      expect(found?.tenantId).toBe("tenant-1");
      expect(found?.status).toBe("pending");
    });

    it("returns null when no pending request exists", () => {
      const result = store.getPendingForTenant("tenant-no-request");
      expect(result).toBeNull();
    });

    it("returns null after the pending request is cancelled", () => {
      const req = store.create("tenant-1", "user-1");
      store.cancel(req.id, "test reason");
      const result = store.getPendingForTenant("tenant-1");
      expect(result).toBeNull();
    });
  });

  describe("cancel()", () => {
    it("changes status to cancelled and sets cancelReason", () => {
      const req = store.create("tenant-1", "user-1");
      store.cancel(req.id, "User changed mind");
      const updated = store.getById(req.id);
      expect(updated?.status).toBe("cancelled");
      expect(updated?.cancelReason).toBe("User changed mind");
    });

    it("does not affect completed requests", () => {
      const req = store.create("tenant-1", "user-1");
      store.markCompleted(req.id, { bot_instances: 2 });
      store.cancel(req.id, "Late cancel attempt");
      const updated = store.getById(req.id);
      // Should still be completed — cancel only applies to pending
      expect(updated?.status).toBe("completed");
    });
  });

  describe("markCompleted()", () => {
    it("sets status to completed, stores summary, and sets completedAt", () => {
      const req = store.create("tenant-1", "user-1");
      store.markCompleted(req.id, { bot_instances: 3, credit_transactions: 10 });
      const updated = store.getById(req.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.completedAt).toBeTruthy();
      expect(JSON.parse(updated?.deletionSummary ?? "null")).toEqual({ bot_instances: 3, credit_transactions: 10 });
    });
  });

  describe("findExpired()", () => {
    it("returns pending requests whose deleteAfter is in the past", () => {
      // Directly insert an expired request
      sqlite.exec(`
        INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
        VALUES ('expired-req', 'tenant-exp', 'user-exp', 'pending', datetime('now', '-1 day'))
      `);
      const expired = store.findExpired();
      expect(expired.length).toBeGreaterThanOrEqual(1);
      const found = expired.find((r) => r.id === "expired-req");
      expect(found).toBeTruthy();
    });

    it("does not return pending requests whose deleteAfter is in the future", () => {
      const req = store.create("tenant-future", "user-future");
      const expired = store.findExpired();
      const found = expired.find((r) => r.id === req.id);
      expect(found).toBeUndefined();
    });

    it("does not return cancelled requests even if past deleteAfter", () => {
      sqlite.exec(`
        INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
        VALUES ('cancelled-old', 'tenant-c', 'user-c', 'cancelled', datetime('now', '-1 day'))
      `);
      const expired = store.findExpired();
      const found = expired.find((r) => r.id === "cancelled-old");
      expect(found).toBeUndefined();
    });

    it("does not return completed requests", () => {
      sqlite.exec(`
        INSERT INTO account_deletion_requests (id, tenant_id, requested_by, status, delete_after)
        VALUES ('completed-old', 'tenant-done', 'user-done', 'completed', datetime('now', '-1 day'))
      `);
      const expired = store.findExpired();
      const found = expired.find((r) => r.id === "completed-old");
      expect(found).toBeUndefined();
    });
  });
});
