import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enforceRetention } from "./retention.js";
import { SnapshotManager } from "./snapshot-manager.js";

const TEST_DIR = join(import.meta.dirname, "../../.test-retention");
const SNAPSHOT_DIR = join(TEST_DIR, "snapshots");
const INSTANCES_DIR = join(TEST_DIR, "instances");
const DB_PATH = join(TEST_DIR, "test.db");

describe("enforceRetention", () => {
  let db: Database.Database;
  let manager: SnapshotManager;
  let woprHomePath: string;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });

    db = new Database(DB_PATH);
    manager = new SnapshotManager({ snapshotDir: SNAPSHOT_DIR, db });

    woprHomePath = join(INSTANCES_DIR, "inst-1");
    await mkdir(woprHomePath, { recursive: true });
    await writeFile(join(woprHomePath, "config.json"), "{}");
  });

  afterEach(async () => {
    db.close();
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
  });

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
  });

  it("enterprise tier allows unlimited snapshots", async () => {
    for (let i = 0; i < 10; i++) {
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });
    }

    const deleted = await enforceRetention(manager, "inst-1", "enterprise");
    expect(deleted).toBe(0);
    expect(manager.count("inst-1")).toBe(10);
  });
});
