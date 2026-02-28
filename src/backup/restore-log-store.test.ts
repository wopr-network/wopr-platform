import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleRestoreLogRepository } from "./restore-log-repository.js";
import { RestoreLogStore } from "./restore-log-store.js";

describe("RestoreLogStore", () => {
  let store: RestoreLogStore;
  let db: DrizzleDb;
  let pool: PGlite;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    const repo = new DrizzleRestoreLogRepository(db);
    store = new RestoreLogStore(repo);
  });

  describe("record", () => {
    it("creates a restore log entry", async () => {
      const entry = await store.record({
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

    it("allows null preRestoreKey", async () => {
      const entry = await store.record({
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
    it("returns entries for tenant, newest first", async () => {
      await store.record({
        tenant: "tenant_abc",
        snapshotKey: "snap1",
        preRestoreKey: null,
        restoredBy: "admin-1",
      });
      await store.record({
        tenant: "tenant_abc",
        snapshotKey: "snap2",
        preRestoreKey: null,
        restoredBy: "admin-1",
      });
      await store.record({
        tenant: "tenant_xyz",
        snapshotKey: "snap3",
        preRestoreKey: null,
        restoredBy: "admin-1",
      });

      const entries = await store.listForTenant("tenant_abc");
      expect(entries).toHaveLength(2);
      expect(entries[0].restoredAt).toBeGreaterThanOrEqual(entries[1].restoredAt);
    });

    it("returns empty array for unknown tenant", async () => {
      expect(await store.listForTenant("unknown")).toEqual([]);
    });
  });

  describe("get", () => {
    it("returns entry by ID", async () => {
      const created = await store.record({
        tenant: "tenant_abc",
        snapshotKey: "snap1",
        preRestoreKey: null,
        restoredBy: "admin-1",
      });

      const found = await store.get(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    it("returns null for unknown ID", async () => {
      expect(await store.get("nonexistent")).toBeNull();
    });
  });
});
