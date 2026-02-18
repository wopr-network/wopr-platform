import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RestoreLogStore } from "./restore-log-store.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE restore_log (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      snapshot_key TEXT NOT NULL,
      pre_restore_key TEXT,
      restored_at INTEGER NOT NULL,
      restored_by TEXT NOT NULL,
      reason TEXT
    );
    CREATE INDEX idx_restore_log_tenant ON restore_log (tenant, restored_at);
    CREATE INDEX idx_restore_log_restored_by ON restore_log (restored_by);
  `);
  const db = drizzle(sqlite);
  return { db, sqlite };
}

describe("RestoreLogStore", () => {
  let sqlite: Database.Database;
  let store: RestoreLogStore;

  beforeEach(() => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    store = new RestoreLogStore(testDb.db);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("record", () => {
    it("creates a restore log entry", () => {
      const entry = store.record({
        tenant: "tenant_abc",
        snapshotKey: "nightly/node-1/tenant_abc/tenant_abc_20260214.tar.gz",
        preRestoreKey: "pre-restore/tenant_abc_pre_restore.tar.gz",
        restoredBy: "admin-user-1",
        reason: "Restoring to last known good state",
      });

      expect(entry.id).toBeDefined();
      expect(entry.tenant).toBe("tenant_abc");
      expect(entry.snapshotKey).toBe("nightly/node-1/tenant_abc/tenant_abc_20260214.tar.gz");
      expect(entry.preRestoreKey).toBe("pre-restore/tenant_abc_pre_restore.tar.gz");
      expect(entry.restoredBy).toBe("admin-user-1");
      expect(entry.reason).toBe("Restoring to last known good state");
      expect(entry.restoredAt).toBeGreaterThan(0);
    });

    it("allows null preRestoreKey", () => {
      const entry = store.record({
        tenant: "tenant_abc",
        snapshotKey: "nightly/node-1/tenant_abc/tenant_abc_20260214.tar.gz",
        preRestoreKey: null,
        restoredBy: "admin-user-1",
      });

      expect(entry.preRestoreKey).toBeNull();
      expect(entry.reason).toBeNull();
    });
  });

  describe("listForTenant", () => {
    it("returns entries for tenant, newest first", () => {
      store.record({
        tenant: "tenant_abc",
        snapshotKey: "snap1",
        preRestoreKey: null,
        restoredBy: "admin-1",
      });
      store.record({
        tenant: "tenant_abc",
        snapshotKey: "snap2",
        preRestoreKey: null,
        restoredBy: "admin-1",
      });
      store.record({
        tenant: "tenant_xyz",
        snapshotKey: "snap3",
        preRestoreKey: null,
        restoredBy: "admin-1",
      });

      const entries = store.listForTenant("tenant_abc");
      expect(entries).toHaveLength(2);
      expect(entries[0].restoredAt).toBeGreaterThanOrEqual(entries[1].restoredAt);
    });

    it("returns empty array for unknown tenant", () => {
      expect(store.listForTenant("unknown")).toEqual([]);
    });
  });

  describe("get", () => {
    it("returns entry by ID", () => {
      const created = store.record({
        tenant: "tenant_abc",
        snapshotKey: "snap1",
        preRestoreKey: null,
        restoredBy: "admin-1",
      });

      const found = store.get(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    it("returns null for unknown ID", () => {
      expect(store.get("nonexistent")).toBeNull();
    });
  });
});
