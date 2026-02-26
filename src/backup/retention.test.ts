import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { enforceRetention } from "./retention.js";
import { SnapshotManager } from "./snapshot-manager.js";
import { DrizzleSnapshotRepository } from "./snapshot-repository.js";

const TEST_DIR = join(import.meta.dirname, "../../.test-retention");
const SNAPSHOT_DIR = join(TEST_DIR, "snapshots");
const INSTANCES_DIR = join(TEST_DIR, "instances");

describe("enforceRetention", () => {
  let manager: SnapshotManager;
  let woprHomePath: string;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });

    const { db } = await createTestDb();
    const repo = new DrizzleSnapshotRepository(db);
    manager = new SnapshotManager({ snapshotDir: SNAPSHOT_DIR, repo });

    woprHomePath = join(INSTANCES_DIR, "inst-1");
    await mkdir(woprHomePath, { recursive: true });
    await writeFile(join(woprHomePath, "config.json"), "{}");
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("deletes oldest snapshots when exceeding free tier limit (3)", async () => {
    // Create 5 snapshots
    for (let i = 0; i < 5; i++) {
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });
    }
    expect(await manager.count("inst-1")).toBe(5);

    const deleted = await enforceRetention(manager, "inst-1", "free");
    expect(deleted).toBe(2); // 5 - 3 = 2 deleted
    expect(await manager.count("inst-1")).toBe(3);
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
    expect(await manager.count("inst-1")).toBe(7);
  }, 30_000);

  it("enterprise tier allows unlimited snapshots", async () => {
    for (let i = 0; i < 10; i++) {
      await manager.create({ instanceId: "inst-1", userId: "user-1", woprHomePath, trigger: "manual" });
    }

    const deleted = await enforceRetention(manager, "inst-1", "enterprise");
    expect(deleted).toBe(0);
    expect(await manager.count("inst-1")).toBe(10);
  }, 30_000);
});
