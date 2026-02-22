import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleBackupStatusRepository } from "./backup-status-repository.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE backup_status (
      container_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      last_backup_at TEXT,
      last_backup_size_mb REAL,
      last_backup_path TEXT,
      last_backup_success INTEGER NOT NULL DEFAULT 0,
      last_backup_error TEXT,
      total_backups INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return drizzle(sqlite, { schema });
}

describe("DrizzleBackupStatusRepository", () => {
  let repo: DrizzleBackupStatusRepository;

  beforeEach(() => {
    repo = new DrizzleBackupStatusRepository(createTestDb());
  });

  it("upsertSuccess creates new entry then increments", () => {
    repo.upsertSuccess("c1", "n1", 100.5, "/path/1");
    let row = repo.getByContainerId("c1");
    expect(row).not.toBeNull();
    expect(row?.lastBackupSizeMb).toBe(100.5);
    expect(row?.lastBackupSuccess).toBe(true);
    expect(row?.totalBackups).toBe(1);

    repo.upsertSuccess("c1", "n1", 200, "/path/2");
    row = repo.getByContainerId("c1");
    expect(row?.totalBackups).toBe(2);
    expect(row?.lastBackupSizeMb).toBe(200);
  });

  it("upsertFailure records error without changing totalBackups", () => {
    repo.upsertSuccess("c1", "n1", 100, "/p");
    repo.upsertFailure("c1", "n1", "disk full");
    const row = repo.getByContainerId("c1");
    expect(row?.lastBackupSuccess).toBe(false);
    expect(row?.lastBackupError).toBe("disk full");
    expect(row?.totalBackups).toBe(1);
  });

  it("getByContainerId returns null for unknown id", () => {
    expect(repo.getByContainerId("nonexistent")).toBeNull();
  });

  it("listAll returns all entries", () => {
    repo.upsertSuccess("c1", "n1", 10, "/p1");
    repo.upsertSuccess("c2", "n1", 20, "/p2");
    repo.upsertFailure("c3", "n2", "err");
    const all = repo.listAll();
    expect(all).toHaveLength(3);
  });

  it("count returns total tracked containers", () => {
    expect(repo.count()).toBe(0);
    repo.upsertSuccess("c1", "n1", 10, "/p");
    repo.upsertSuccess("c2", "n1", 10, "/p");
    expect(repo.count()).toBe(2);
  });
});
