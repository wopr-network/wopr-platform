import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import type { NewSnapshotRow } from "./repository-types.js";
import { DrizzleSnapshotRepository } from "./snapshot-repository.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE snapshots (
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
    CREATE INDEX idx_snapshots_instance ON snapshots (instance_id);
    CREATE INDEX idx_snapshots_tenant ON snapshots (tenant);
    CREATE INDEX idx_snapshots_type ON snapshots (type);
    CREATE INDEX idx_snapshots_expires ON snapshots (expires_at);
  `);
  return drizzle(sqlite, { schema });
}

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

  beforeEach(() => {
    repo = new DrizzleSnapshotRepository(createTestDb());
  });

  it("insert + getById round-trips a snapshot", () => {
    repo.insert(makeRow());
    const found = repo.getById("snap-1");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("snap-1");
    expect(found?.instanceId).toBe("inst-1");
    expect(found?.plugins).toEqual([]);
  });

  it("getById returns null for unknown id", () => {
    expect(repo.getById("nonexistent")).toBeNull();
  });

  it("list returns non-deleted snapshots for instance", () => {
    repo.insert(makeRow({ id: "s1", instanceId: "inst-1" }));
    repo.insert(makeRow({ id: "s2", instanceId: "inst-1" }));
    repo.insert(makeRow({ id: "s3", instanceId: "inst-2" }));
    const list = repo.list("inst-1");
    expect(list).toHaveLength(2);
  });

  it("softDelete sets deletedAt, excludes from list", () => {
    repo.insert(makeRow({ id: "s1" }));
    repo.softDelete("s1");
    expect(repo.list("inst-1")).toHaveLength(0);
    const found = repo.getById("s1");
    expect(found?.deletedAt).not.toBeNull();
  });

  it("hardDelete removes from DB entirely", () => {
    repo.insert(makeRow({ id: "s1" }));
    repo.hardDelete("s1");
    expect(repo.getById("s1")).toBeNull();
  });

  it("count returns non-deleted snapshots for instance", () => {
    repo.insert(makeRow({ id: "s1", instanceId: "inst-1" }));
    repo.insert(makeRow({ id: "s2", instanceId: "inst-1" }));
    expect(repo.count("inst-1")).toBe(2);
  });

  it("listExpired returns snapshots past their expiry", () => {
    const past = Date.now() - 1000;
    const future = Date.now() + 100000;
    repo.insert(makeRow({ id: "s1", expiresAt: past }));
    repo.insert(makeRow({ id: "s2", expiresAt: future }));
    const expired = repo.listExpired(Date.now());
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe("s1");
  });

  it("countByTenant counts on-demand non-deleted for tenant", () => {
    repo.insert(makeRow({ id: "s1", tenant: "t1", type: "on-demand" }));
    repo.insert(makeRow({ id: "s2", tenant: "t1", type: "nightly" }));
    expect(repo.countByTenant("t1", "on-demand")).toBe(1);
  });

  it("getOldest returns snapshots in ascending creation order", () => {
    repo.insert(makeRow({ id: "s1", instanceId: "i1", createdAt: "2026-01-01T00:00:00Z" }));
    repo.insert(makeRow({ id: "s2", instanceId: "i1", createdAt: "2026-01-02T00:00:00Z" }));
    repo.insert(makeRow({ id: "s3", instanceId: "i1", createdAt: "2026-01-03T00:00:00Z" }));
    const oldest = repo.getOldest("i1", 2);
    expect(oldest).toHaveLength(2);
    expect(oldest[0].id).toBe("s1");
    expect(oldest[1].id).toBe("s2");
  });
});
