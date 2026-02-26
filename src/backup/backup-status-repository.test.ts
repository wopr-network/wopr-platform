import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test/db.js";
import { DrizzleBackupStatusRepository } from "./backup-status-repository.js";

describe("DrizzleBackupStatusRepository", () => {
  let repo: DrizzleBackupStatusRepository;

  beforeEach(async () => {
    const { db } = await createTestDb();
    repo = new DrizzleBackupStatusRepository(db);
  });

  it("upsertSuccess creates new entry then increments", async () => {
    await repo.upsertSuccess("c1", "n1", 100.5, "/path/1");
    let row = await repo.getByContainerId("c1");
    expect(row).not.toBeNull();
    expect(row?.lastBackupSizeMb).toBe(100.5);
    expect(row?.lastBackupSuccess).toBe(true);
    expect(row?.totalBackups).toBe(1);

    await repo.upsertSuccess("c1", "n1", 200, "/path/2");
    row = await repo.getByContainerId("c1");
    expect(row?.totalBackups).toBe(2);
    expect(row?.lastBackupSizeMb).toBe(200);
  });

  it("upsertFailure records error without changing totalBackups", async () => {
    await repo.upsertSuccess("c1", "n1", 100, "/p");
    await repo.upsertFailure("c1", "n1", "disk full");
    const row = await repo.getByContainerId("c1");
    expect(row?.lastBackupSuccess).toBe(false);
    expect(row?.lastBackupError).toBe("disk full");
    expect(row?.totalBackups).toBe(1);
  });

  it("getByContainerId returns null for unknown id", async () => {
    expect(await repo.getByContainerId("nonexistent")).toBeNull();
  });

  it("listAll returns all entries", async () => {
    await repo.upsertSuccess("c1", "n1", 10, "/p1");
    await repo.upsertSuccess("c2", "n1", 20, "/p2");
    await repo.upsertFailure("c3", "n2", "err");
    const all = await repo.listAll();
    expect(all).toHaveLength(3);
  });

  it("count returns total tracked containers", async () => {
    expect(await repo.count()).toBe(0);
    await repo.upsertSuccess("c1", "n1", 10, "/p");
    await repo.upsertSuccess("c2", "n1", 10, "/p");
    expect(await repo.count()).toBe(2);
  });
});
