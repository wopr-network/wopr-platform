import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { DrizzleBackupStatusRepository } from "./backup-status-repository.js";
import { BackupStatusStore } from "./backup-status-store.js";

describe("BackupStatusStore", () => {
  let store: BackupStatusStore;

  beforeEach(async () => {
    const { db } = await createTestDb();
    const repo = new DrizzleBackupStatusRepository(db);
    store = new BackupStatusStore(repo);
  });

  describe("recordSuccess", () => {
    it("creates a new entry on first success", async () => {
      await store.recordSuccess("tenant_abc", "node-1", 150.5, "nightly/node-1/tenant_abc/backup.tar.gz");

      const entry = await store.get("tenant_abc");
      expect(entry).not.toBeNull();
      expect(entry?.containerId).toBe("tenant_abc");
      expect(entry?.nodeId).toBe("node-1");
      expect(entry?.lastBackupSizeMb).toBe(150.5);
      expect(entry?.lastBackupSuccess).toBe(true);
      expect(entry?.lastBackupError).toBeNull();
      expect(entry?.totalBackups).toBe(1);
    });

    it("increments totalBackups on subsequent successes", async () => {
      await store.recordSuccess("tenant_abc", "node-1", 100, "path1");
      await store.recordSuccess("tenant_abc", "node-1", 110, "path2");
      await store.recordSuccess("tenant_abc", "node-1", 120, "path3");

      const entry = await store.get("tenant_abc");
      expect(entry?.totalBackups).toBe(3);
      expect(entry?.lastBackupSizeMb).toBe(120);
    });
  });

  describe("recordFailure", () => {
    it("records a failure for a new container", async () => {
      await store.recordFailure("tenant_xyz", "node-2", "disk full");

      const entry = await store.get("tenant_xyz");
      expect(entry).not.toBeNull();
      expect(entry?.lastBackupSuccess).toBe(false);
      expect(entry?.lastBackupError).toBe("disk full");
      expect(entry?.totalBackups).toBe(0);
    });

    it("updates failure after a previous success", async () => {
      await store.recordSuccess("tenant_abc", "node-1", 100, "path1");
      await store.recordFailure("tenant_abc", "node-1", "network timeout");

      const entry = await store.get("tenant_abc");
      expect(entry?.lastBackupSuccess).toBe(false);
      expect(entry?.lastBackupError).toBe("network timeout");
      // totalBackups should not change on failure
      expect(entry?.totalBackups).toBe(1);
    });
  });

  describe("listAll", () => {
    it("returns all entries", async () => {
      await store.recordSuccess("tenant_a", "node-1", 100, "path-a");
      await store.recordSuccess("tenant_b", "node-1", 200, "path-b");
      await store.recordFailure("tenant_c", "node-2", "error");

      const entries = await store.listAll();
      expect(entries).toHaveLength(3);
    });

    it("returns empty array when no entries exist", async () => {
      expect(await store.listAll()).toEqual([]);
    });
  });

  describe("listStale", () => {
    it("marks entries as stale when no successful backup exists", async () => {
      await store.recordFailure("tenant_abc", "node-1", "failed");

      const stale = await store.listStale();
      expect(stale).toHaveLength(1);
      expect(stale[0].isStale).toBe(true);
    });
  });

  describe("count", () => {
    it("returns the number of tracked containers", async () => {
      expect(await store.count()).toBe(0);
      await store.recordSuccess("tenant_a", "node-1", 100, "p");
      await store.recordSuccess("tenant_b", "node-1", 100, "p");
      expect(await store.count()).toBe(2);
    });
  });

  describe("get", () => {
    it("returns null for unknown container", async () => {
      expect(await store.get("nonexistent")).toBeNull();
    });
  });
});
