import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import type { NewSnapshotRow } from "./repository-types.js";
import { DrizzleSnapshotRepository } from "./snapshot-repository.js";

function makeRow(overrides: Partial<NewSnapshotRow> = {}): NewSnapshotRow {
  return {
    id: "snap-1",
    tenant: "t1",
    instanceId: "inst-1",
    userId: "user-1",
    name: null,
    type: "on-demand",
    s3Key: null,
    sizeMb: 10,
    sizeBytes: 10485760,
    nodeId: null,
    trigger: "manual",
    plugins: "[]",
    configHash: "abc",
    storagePath: "/tmp/snap.tar.gz",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("DrizzleSnapshotRepository", () => {
  let repo: DrizzleSnapshotRepository;

  beforeEach(async () => {
    const { db } = await createTestDb();
    repo = new DrizzleSnapshotRepository(db);
  });

  it("insert + getById round-trips a snapshot", async () => {
    await repo.insert(makeRow());
    const found = await repo.getById("snap-1");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("snap-1");
    expect(found?.instanceId).toBe("inst-1");
    expect(found?.plugins).toEqual([]);
  });

  it("getById returns null for unknown id", async () => {
    expect(await repo.getById("nonexistent")).toBeNull();
  });

  it("list returns non-deleted snapshots for instance", async () => {
    await repo.insert(makeRow({ id: "s1", instanceId: "inst-1" }));
    await repo.insert(makeRow({ id: "s2", instanceId: "inst-1" }));
    await repo.insert(makeRow({ id: "s3", instanceId: "inst-2" }));
    const list = await repo.list("inst-1");
    expect(list).toHaveLength(2);
  });

  it("softDelete sets deletedAt, excludes from list", async () => {
    await repo.insert(makeRow({ id: "s1" }));
    await repo.softDelete("s1");
    expect(await repo.list("inst-1")).toHaveLength(0);
    const found = await repo.getById("s1");
    expect(found?.deletedAt).not.toBeNull();
  });

  it("hardDelete removes from DB entirely", async () => {
    await repo.insert(makeRow({ id: "s1" }));
    await repo.hardDelete("s1");
    expect(await repo.getById("s1")).toBeNull();
  });

  it("count returns non-deleted snapshots for instance", async () => {
    await repo.insert(makeRow({ id: "s1", instanceId: "inst-1" }));
    await repo.insert(makeRow({ id: "s2", instanceId: "inst-1" }));
    expect(await repo.count("inst-1")).toBe(2);
  });

  it("listExpired returns snapshots past their expiry", async () => {
    const past = Date.now() - 1000;
    const future = Date.now() + 100000;
    await repo.insert(makeRow({ id: "s1", expiresAt: past }));
    await repo.insert(makeRow({ id: "s2", expiresAt: future }));
    const expired = await repo.listExpired(Date.now());
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe("s1");
  });

  it("countByTenant counts on-demand non-deleted for tenant", async () => {
    await repo.insert(makeRow({ id: "s1", tenant: "t1", type: "on-demand" }));
    await repo.insert(makeRow({ id: "s2", tenant: "t1", type: "nightly" }));
    expect(await repo.countByTenant("t1", "on-demand")).toBe(1);
  });

  it("getOldest returns snapshots in ascending creation order", async () => {
    await repo.insert(makeRow({ id: "s1", instanceId: "i1", createdAt: "2026-01-01T00:00:00Z" }));
    await repo.insert(makeRow({ id: "s2", instanceId: "i1", createdAt: "2026-01-02T00:00:00Z" }));
    await repo.insert(makeRow({ id: "s3", instanceId: "i1", createdAt: "2026-01-03T00:00:00Z" }));
    const oldest = await repo.getOldest("i1", 2);
    expect(oldest).toHaveLength(2);
    expect(oldest[0].id).toBe("s1");
    expect(oldest[1].id).toBe("s2");
  });
});
