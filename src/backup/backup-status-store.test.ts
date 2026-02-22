import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleBackupStatusRepository } from "./backup-status-repository.js";
import { BackupStatusStore } from "./backup-status-store.js";

const TEST_DIR = join(import.meta.dirname, "../../.test-backup-status");
const DB_PATH = join(TEST_DIR, "backup-status.db");

function createTestDb(path: string) {
  mkdirSync(TEST_DIR, { recursive: true });

  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS backup_status (
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
    CREATE INDEX IF NOT EXISTS idx_backup_status_node ON backup_status (node_id);
    CREATE INDEX IF NOT EXISTS idx_backup_status_last_backup ON backup_status (last_backup_at);
  `);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

describe("BackupStatusStore", () => {
  let sqlite: Database.Database;
  let store: BackupStatusStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    const testDb = createTestDb(DB_PATH);
    sqlite = testDb.sqlite;
    const repo = new DrizzleBackupStatusRepository(testDb.db);
    store = new BackupStatusStore(repo);
  });

  afterEach(async () => {
    sqlite.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("recordSuccess", () => {
    it("creates a new entry on first success", () => {
      store.recordSuccess("tenant_abc", "node-1", 150.5, "nightly/node-1/tenant_abc/backup.tar.gz");

      const entry = store.get("tenant_abc");
      expect(entry).not.toBeNull();
      expect(entry?.containerId).toBe("tenant_abc");
      expect(entry?.nodeId).toBe("node-1");
      expect(entry?.lastBackupSizeMb).toBe(150.5);
      expect(entry?.lastBackupSuccess).toBe(true);
      expect(entry?.lastBackupError).toBeNull();
      expect(entry?.totalBackups).toBe(1);
    });

    it("increments totalBackups on subsequent successes", () => {
      store.recordSuccess("tenant_abc", "node-1", 100, "path1");
      store.recordSuccess("tenant_abc", "node-1", 110, "path2");
      store.recordSuccess("tenant_abc", "node-1", 120, "path3");

      const entry = store.get("tenant_abc");
      expect(entry?.totalBackups).toBe(3);
      expect(entry?.lastBackupSizeMb).toBe(120);
    });
  });

  describe("recordFailure", () => {
    it("records a failure for a new container", () => {
      store.recordFailure("tenant_xyz", "node-2", "disk full");

      const entry = store.get("tenant_xyz");
      expect(entry).not.toBeNull();
      expect(entry?.lastBackupSuccess).toBe(false);
      expect(entry?.lastBackupError).toBe("disk full");
      expect(entry?.totalBackups).toBe(0);
    });

    it("updates failure after a previous success", () => {
      store.recordSuccess("tenant_abc", "node-1", 100, "path1");
      store.recordFailure("tenant_abc", "node-1", "network timeout");

      const entry = store.get("tenant_abc");
      expect(entry?.lastBackupSuccess).toBe(false);
      expect(entry?.lastBackupError).toBe("network timeout");
      // totalBackups should not change on failure
      expect(entry?.totalBackups).toBe(1);
    });
  });

  describe("listAll", () => {
    it("returns all entries", () => {
      store.recordSuccess("tenant_a", "node-1", 100, "path-a");
      store.recordSuccess("tenant_b", "node-1", 200, "path-b");
      store.recordFailure("tenant_c", "node-2", "error");

      const entries = store.listAll();
      expect(entries).toHaveLength(3);
    });

    it("returns empty array when no entries exist", () => {
      expect(store.listAll()).toEqual([]);
    });
  });

  describe("listStale", () => {
    it("marks entries as stale when no successful backup exists", () => {
      store.recordFailure("tenant_abc", "node-1", "failed");

      const stale = store.listStale();
      expect(stale).toHaveLength(1);
      expect(stale[0].isStale).toBe(true);
    });
  });

  describe("count", () => {
    it("returns the number of tracked containers", () => {
      expect(store.count()).toBe(0);
      store.recordSuccess("tenant_a", "node-1", 100, "p");
      store.recordSuccess("tenant_b", "node-1", 100, "p");
      expect(store.count()).toBe(2);
    });
  });

  describe("get", () => {
    it("returns null for unknown container", () => {
      expect(store.get("nonexistent")).toBeNull();
    });
  });
});
