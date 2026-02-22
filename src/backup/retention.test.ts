import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { enforceRetention } from "./retention.js";
import { SnapshotManager } from "./snapshot-manager.js";
import { DrizzleSnapshotRepository } from "./snapshot-repository.js";

const TEST_DIR = join(import.meta.dirname, "../../.test-retention");
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

describe("enforceRetention", () => {
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

    woprHomePath = join(INSTANCES_DIR, "inst-1");
    await mkdir(woprHomePath, { recursive: true });
    await writeFile(join(woprHomePath, "config.json"), "{}");
  });

  afterEach(async () => {
    sqlite.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("deletes oldest snapshots when exceeding free tier limit (3)", async () => {
    // Create 5 snapshots
    for (let i = 0; i < 5; i++) {
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });
    }
    expect(manager.count("inst-1")).toBe(5);

    const deleted = await enforceRetention(manager, "inst-1", "free");
    expect(deleted).toBe(2); // 5 - 3 = 2 deleted
    expect(manager.count("inst-1")).toBe(3);
  }, 30_000);

  it("does nothing when under the limit", async () => {
    await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });

    const deleted = await enforceRetention(manager, "inst-1", "free");
    expect(deleted).toBe(0);
  });

  it("respects pro tier limit (7)", async () => {
    for (let i = 0; i < 9; i++) {
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });
    }

    const deleted = await enforceRetention(manager, "inst-1", "pro");
    expect(deleted).toBe(2); // 9 - 7 = 2
    expect(manager.count("inst-1")).toBe(7);
  }, 30_000);

  it("enterprise tier allows unlimited snapshots", async () => {
    for (let i = 0; i < 10; i++) {
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });
    }

    const deleted = await enforceRetention(manager, "inst-1", "enterprise");
    expect(deleted).toBe(0);
    expect(manager.count("inst-1")).toBe(10);
  }, 30_000);
});
