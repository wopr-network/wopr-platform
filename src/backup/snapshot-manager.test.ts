import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { SnapshotManager, SnapshotNotFoundError } from "./snapshot-manager.js";
import { DrizzleSnapshotRepository } from "./snapshot-repository.js";

const TEST_DIR = join(import.meta.dirname, "../../.test-snapshots");
const SNAPSHOT_DIR = join(TEST_DIR, "snapshots");
const INSTANCES_DIR = join(TEST_DIR, "instances");
const DB_PATH = join(TEST_DIR, "test.db");

/** Create a file-based Drizzle DB with the snapshots table. */
function createFileDb(path: string) {
  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL DEFAULT '',
      instance_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      type TEXT NOT NULL DEFAULT 'on-demand' CHECK (type IN ('nightly', 'on-demand', 'pre-restore')),
      s3_key TEXT,
      size_mb REAL NOT NULL DEFAULT 0,
      size_bytes INTEGER,
      node_id TEXT,
      trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'pre_update')),
      plugins TEXT NOT NULL DEFAULT '[]',
      config_hash TEXT NOT NULL DEFAULT '',
      storage_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at INTEGER,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_instance ON snapshots (instance_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_user ON snapshots (user_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_tenant ON snapshots (tenant);
    CREATE INDEX IF NOT EXISTS idx_snapshots_type ON snapshots (type);
    CREATE INDEX IF NOT EXISTS idx_snapshots_expires ON snapshots (expires_at);
  `);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

describe("SnapshotManager", () => {
  let sqlite: Database.Database;
  let manager: SnapshotManager;
  let woprHomePath: string;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });

    const testDb = createFileDb(DB_PATH);
    sqlite = testDb.sqlite;
    const repo = new DrizzleSnapshotRepository(testDb.db);
    manager = new SnapshotManager({ snapshotDir: SNAPSHOT_DIR, repo });

    // Create a fake WOPR_HOME with some files
    woprHomePath = join(INSTANCES_DIR, "inst-1");
    await mkdir(woprHomePath, { recursive: true });
    await writeFile(join(woprHomePath, "config.json"), JSON.stringify({ key: "value" }));
    await writeFile(join(woprHomePath, "data.txt"), "hello world");
  });

  afterEach(async () => {
    sqlite.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("create", () => {
    it("creates a tar.gz snapshot and stores metadata", async () => {
      const snapshot = await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        plugins: ["discord", "slack"],
      });

      expect(snapshot.id).toBeDefined();
      expect(snapshot.instanceId).toBe("inst-1");
      expect(snapshot.userId).toBe("user-1");
      expect(snapshot.trigger).toBe("manual");
      expect(snapshot.plugins).toEqual(["discord", "slack"]);
      expect(snapshot.configHash).toHaveLength(64); // SHA-256 hex
      expect(snapshot.sizeMb).toBeGreaterThanOrEqual(0);

      // Verify tar file exists
      const tarStat = await stat(snapshot.storagePath);
      expect(tarStat.isFile()).toBe(true);
    });

    it("handles missing config.json gracefully", async () => {
      await rm(join(woprHomePath, "config.json"));

      const snapshot = await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "scheduled",
      });

      expect(snapshot.configHash).toBe("");
      expect(snapshot.plugins).toEqual([]);
    });
  });

  describe("get", () => {
    it("returns snapshot by id", async () => {
      const created = await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
      });

      const found = manager.get(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.instanceId).toBe("inst-1");
    });

    it("returns null for unknown id", () => {
      expect(manager.get("nonexistent")).toBeNull();
    });
  });

  describe("list", () => {
    it("lists snapshots for an instance, newest first", async () => {
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "scheduled" });
      await manager.create({ instanceId: "inst-2", userId: "user-1", woprHomePath, trigger: "manual" });

      const list = manager.list("inst-1");
      expect(list).toHaveLength(2);
      // Newest first
      expect(new Date(list[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(list[1].createdAt).getTime());
    });

    it("returns empty array for instance with no snapshots", () => {
      expect(manager.list("no-such-instance")).toEqual([]);
    });
  });

  describe("delete (soft-delete)", () => {
    it("soft-deletes snapshot: sets deletedAt, excludes from list and count", async () => {
      const snapshot = await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
      });

      const deleted = await manager.delete(snapshot.id);
      expect(deleted).toBe(true);

      // Soft-deleted: still retrievable by id, but not in list/count
      const found = manager.get(snapshot.id);
      expect(found).not.toBeNull();
      expect(found?.deletedAt).not.toBeNull();

      // Not in list
      const listed = manager.list("inst-1");
      expect(listed.find((s) => s.id === snapshot.id)).toBeUndefined();

      // Not counted
      expect(manager.count("inst-1")).toBe(0);
    });

    it("returns false for unknown snapshot", async () => {
      expect(await manager.delete("nonexistent")).toBe(false);
    });
  });

  describe("hardDelete", () => {
    it("removes snapshot tar and DB row", async () => {
      const snapshot = await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
      });

      const deleted = await manager.hardDelete(snapshot.id);
      expect(deleted).toBe(true);

      expect(manager.get(snapshot.id)).toBeNull();
    }, 30_000);

    it("returns false for unknown snapshot", async () => {
      expect(await manager.hardDelete("nonexistent")).toBe(false);
    }, 30_000);
  });

  describe("restore", () => {
    it("restores WOPR_HOME from snapshot", async () => {
      const snapshot = await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
      });

      // Modify the current WOPR_HOME
      await writeFile(join(woprHomePath, "config.json"), JSON.stringify({ key: "modified" }));
      await writeFile(join(woprHomePath, "extra.txt"), "should be removed");

      // Restore from snapshot
      await manager.restore(snapshot.id, woprHomePath);

      // Verify original content is restored
      const config = JSON.parse(await readFile(join(woprHomePath, "config.json"), "utf-8"));
      expect(config.key).toBe("value");
      const data = await readFile(join(woprHomePath, "data.txt"), "utf-8");
      expect(data).toBe("hello world");
    });

    it("throws SnapshotNotFoundError for unknown snapshot", async () => {
      await expect(manager.restore("nonexistent", woprHomePath)).rejects.toThrow(SnapshotNotFoundError);
    });
  });

  describe("count", () => {
    it("counts snapshots for an instance", async () => {
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });

      expect(manager.count("inst-1")).toBe(2);
      expect(manager.count("inst-2")).toBe(0);
    });
  });

  describe("getOldest", () => {
    it("returns oldest snapshots first", async () => {
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });

      const oldest = manager.getOldest("inst-1", 2);
      expect(oldest).toHaveLength(2);
      expect(new Date(oldest[0].createdAt).getTime()).toBeLessThanOrEqual(new Date(oldest[1].createdAt).getTime());
    });
  });

  describe("listByTenant", () => {
    it("lists non-deleted snapshots for a tenant", async () => {
      await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        tenant: "tenant-a",
      });
      await manager.create({
        instanceId: "inst-2",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        tenant: "tenant-a",
      });
      await manager.create({
        instanceId: "inst-3",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        tenant: "tenant-b",
      });

      const list = manager.listByTenant("tenant-a");
      expect(list).toHaveLength(2);
      expect(list.every((s) => s.tenant === "tenant-a")).toBe(true);
    });

    it("filters by type when provided", async () => {
      await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        tenant: "tenant-a",
        type: "on-demand",
      });
      await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "scheduled",
        tenant: "tenant-a",
        type: "nightly",
      });

      const onDemand = manager.listByTenant("tenant-a", "on-demand");
      expect(onDemand).toHaveLength(1);
      expect(onDemand[0].type).toBe("on-demand");
    });
  });

  describe("countByTenant", () => {
    it("counts on-demand snapshots for a tenant", async () => {
      await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        tenant: "tenant-a",
        type: "on-demand",
      });
      await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "scheduled",
        tenant: "tenant-a",
        type: "nightly",
      });
      await manager.create({
        instanceId: "inst-2",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        tenant: "tenant-b",
        type: "on-demand",
      });

      expect(manager.countByTenant("tenant-a", "on-demand")).toBe(1);
      expect(manager.countByTenant("tenant-b", "on-demand")).toBe(1);
    });

    it("excludes soft-deleted snapshots from count", async () => {
      const snap = await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        tenant: "tenant-a",
        type: "on-demand",
      });
      await manager.delete(snap.id);

      expect(manager.countByTenant("tenant-a", "on-demand")).toBe(0);
    });
  });

  describe("listAllActive", () => {
    it("lists all non-deleted on-demand snapshots across all tenants", async () => {
      await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        tenant: "tenant-a",
        type: "on-demand",
      });
      await manager.create({
        instanceId: "inst-2",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        tenant: "tenant-b",
        type: "on-demand",
      });
      await manager.create({
        instanceId: "inst-3",
        userId: "user-1",
        woprHomePath,
        trigger: "scheduled",
        tenant: "tenant-a",
        type: "nightly",
      });

      const active = manager.listAllActive("on-demand");
      expect(active).toHaveLength(2);
      expect(active.every((s) => s.type === "on-demand")).toBe(true);
    });
  });

  describe("listExpired", () => {
    it("lists snapshots past their expiresAt", async () => {
      const pastExpiry = Date.now() - 1000;
      const futureExpiry = Date.now() + 1_000_000;

      // We insert directly via the DB since create() doesn't allow past expiresAt
      // Just use future expiry and a past expiry snapshot created manually
      const s1 = await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        tenant: "tenant-a",
        expiresAt: pastExpiry,
      });
      const s2 = await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
        tenant: "tenant-a",
        expiresAt: futureExpiry,
      });

      const expired = manager.listExpired(Date.now());
      expect(expired.some((s) => s.id === s1.id)).toBe(true);
      expect(expired.some((s) => s.id === s2.id)).toBe(false);
    });
  });
});
