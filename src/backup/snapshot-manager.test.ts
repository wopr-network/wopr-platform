import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { SnapshotManager, SnapshotNotFoundError } from "./snapshot-manager.js";

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
      instance_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      size_mb REAL NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'pre_update')),
      plugins TEXT NOT NULL DEFAULT '[]',
      config_hash TEXT NOT NULL DEFAULT '',
      storage_path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_instance ON snapshots (instance_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_user ON snapshots (user_id);
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
    manager = new SnapshotManager({ snapshotDir: SNAPSHOT_DIR, db: testDb.db });

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

  describe("delete", () => {
    it("removes snapshot tar and metadata", async () => {
      const snapshot = await manager.create({
        instanceId: "inst-1",
        userId: "user-1",
        woprHomePath,
        trigger: "manual",
      });

      const deleted = await manager.delete(snapshot.id);
      expect(deleted).toBe(true);

      expect(manager.get(snapshot.id)).toBeNull();
    });

    it("returns false for unknown snapshot", async () => {
      expect(await manager.delete("nonexistent")).toBe(false);
    });
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
});
