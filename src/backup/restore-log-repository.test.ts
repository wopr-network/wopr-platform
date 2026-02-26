import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { DrizzleRestoreLogRepository } from "./restore-log-repository.js";

describe("DrizzleRestoreLogRepository", () => {
  let repo: DrizzleRestoreLogRepository;

  beforeEach(async () => {
    const { db } = await createTestDb();
    repo = new DrizzleRestoreLogRepository(db);
  });

  it("insert + getById round-trips an entry", async () => {
    const entry = {
      id: "rl-1",
      tenant: "tenant_abc",
      snapshotKey: "nightly/snap.tar.gz",
      preRestoreKey: "pre-restore/snap.tar.gz",
      restoredAt: 1700000000,
      restoredBy: "admin-1",
      reason: "rollback",
    };
    await repo.insert(entry);
    const found = await repo.getById("rl-1");
    expect(found).toEqual(entry);
  });

  it("getById returns null for unknown id", async () => {
    expect(await repo.getById("nonexistent")).toBeNull();
  });

  it("listByTenant returns entries newest-first with limit", async () => {
    await repo.insert({
      id: "rl-1",
      tenant: "t1",
      snapshotKey: "s1",
      preRestoreKey: null,
      restoredAt: 100,
      restoredBy: "a",
      reason: null,
    });
    await repo.insert({
      id: "rl-2",
      tenant: "t1",
      snapshotKey: "s2",
      preRestoreKey: null,
      restoredAt: 200,
      restoredBy: "a",
      reason: null,
    });
    await repo.insert({
      id: "rl-3",
      tenant: "t1",
      snapshotKey: "s3",
      preRestoreKey: null,
      restoredAt: 300,
      restoredBy: "a",
      reason: null,
    });
    await repo.insert({
      id: "rl-4",
      tenant: "t2",
      snapshotKey: "s4",
      preRestoreKey: null,
      restoredAt: 400,
      restoredBy: "a",
      reason: null,
    });

    const results = await repo.listByTenant("t1", 2);
    expect(results).toHaveLength(2);
    expect(results[0].restoredAt).toBe(300);
    expect(results[1].restoredAt).toBe(200);
  });
});
