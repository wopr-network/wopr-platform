import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleRestoreLogRepository } from "./restore-log-repository.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE restore_log (
      id TEXT PRIMARY KEY,
      tenant TEXT NOT NULL,
      snapshot_key TEXT NOT NULL,
      pre_restore_key TEXT,
      restored_at INTEGER NOT NULL,
      restored_by TEXT NOT NULL,
      reason TEXT
    );
    CREATE INDEX idx_restore_log_tenant ON restore_log (tenant, restored_at);
  `);
  return drizzle(sqlite, { schema });
}

describe("DrizzleRestoreLogRepository", () => {
  let repo: DrizzleRestoreLogRepository;

  beforeEach(() => {
    repo = new DrizzleRestoreLogRepository(createTestDb());
  });

  it("insert + getById round-trips an entry", () => {
    const entry = {
      id: "rl-1",
      tenant: "tenant_abc",
      snapshotKey: "nightly/snap.tar.gz",
      preRestoreKey: "pre-restore/snap.tar.gz",
      restoredAt: 1700000000,
      restoredBy: "admin-1",
      reason: "rollback",
    };
    repo.insert(entry);
    const found = repo.getById("rl-1");
    expect(found).toEqual(entry);
  });

  it("getById returns null for unknown id", () => {
    expect(repo.getById("nonexistent")).toBeNull();
  });

  it("listByTenant returns entries newest-first with limit", () => {
    repo.insert({
      id: "rl-1",
      tenant: "t1",
      snapshotKey: "s1",
      preRestoreKey: null,
      restoredAt: 100,
      restoredBy: "a",
      reason: null,
    });
    repo.insert({
      id: "rl-2",
      tenant: "t1",
      snapshotKey: "s2",
      preRestoreKey: null,
      restoredAt: 200,
      restoredBy: "a",
      reason: null,
    });
    repo.insert({
      id: "rl-3",
      tenant: "t1",
      snapshotKey: "s3",
      preRestoreKey: null,
      restoredAt: 300,
      restoredBy: "a",
      reason: null,
    });
    repo.insert({
      id: "rl-4",
      tenant: "t2",
      snapshotKey: "s4",
      preRestoreKey: null,
      restoredAt: 400,
      restoredBy: "a",
      reason: null,
    });

    const results = repo.listByTenant("t1", 2);
    expect(results).toHaveLength(2);
    expect(results[0].restoredAt).toBe(300);
    expect(results[1].restoredAt).toBe(200);
  });
});
