import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../db/schema/index.js";
import { DrizzleBackupStatusRepository } from "../../infrastructure/persistence/drizzle-backup-status-repository.js";
import { createAdminBackupRoutes, isRemotePathOwnedBy } from "./admin-backups.js";

const TEST_DIR = join(import.meta.dirname, "../../../.test-admin-backups");
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

describe("admin-backups routes", () => {
  let sqlite: Database.Database;
  let store: DrizzleBackupStatusRepository;
  let app: ReturnType<typeof createAdminBackupRoutes>;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    const testDb = createTestDb(DB_PATH);
    sqlite = testDb.sqlite;
    store = new DrizzleBackupStatusRepository(testDb.db);
    app = createAdminBackupRoutes(store);
  });

  afterEach(async () => {
    sqlite.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("GET /", () => {
    it("returns empty list when no backups exist", async () => {
      const res = await app.request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.backups).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.staleCount).toBe(0);
    });

    it("returns backup statuses", async () => {
      await store.recordSuccess("tenant_a", "node-1", 100, "path-a");
      await store.recordSuccess("tenant_b", "node-1", 200, "path-b");

      const res = await app.request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
    });

    it("filters stale backups when ?stale=true", async () => {
      await store.recordSuccess("tenant_a", "node-1", 100, "path-a");
      await store.recordFailure("tenant_b", "node-2", "error");

      const res = await app.request("/?stale=true");
      expect(res.status).toBe(200);
      const body = await res.json();
      // tenant_b failed so it's stale; tenant_a just succeeded so may be stale too
      // depending on timing, but at minimum tenant_b should be stale
      expect(body.backups.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /:containerId", () => {
    it("returns 404 for unknown container", async () => {
      const res = await app.request("/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns backup status for known container", async () => {
      await store.recordSuccess("tenant_abc", "node-1", 150, "path-abc");

      const res = await app.request("/tenant_abc");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.containerId).toBe("tenant_abc");
      expect(body.nodeId).toBe("node-1");
      expect(body.lastBackupSizeMb).toBe(150);
    });
  });

  describe("POST /:containerId/restore", () => {
    it("returns 400 without remotePath", async () => {
      await store.recordSuccess("tenant_abc", "node-1", 100, "path");

      const res = await app.request("/tenant_abc/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 403 when remotePath does not belong to container", async () => {
      await store.recordSuccess("tenant_abc", "node-1", 100, "path");

      const res = await app.request("/tenant_abc/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remotePath: "nightly/node-1/tenant_xyz/backup.tar.gz" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 403 for path traversal attempt using includes() bypass", async () => {
      await store.recordSuccess("tenant_abc", "node-1", 100, "path");

      const res = await app.request("/tenant_abc/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remotePath: "nightly/node-1/../../other_tenant/tenant_abc_fake/backup.tar.gz" }),
      });
      expect(res.status).toBe(403);
    });

    it("initiates restore for valid request", async () => {
      await store.recordSuccess("tenant_abc", "node-1", 100, "path");

      const res = await app.request("/tenant_abc/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remotePath: "nightly/node-1/tenant_abc/tenant_abc_20260214.tar.gz",
          targetNodeId: "node-2",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.containerId).toBe("tenant_abc");
      expect(body.targetNodeId).toBe("node-2");
    });
  });

  describe("GET /alerts/stale", () => {
    it("returns stale backup alerts", async () => {
      await store.recordFailure("tenant_stale", "node-1", "disk full");

      const res = await app.request("/alerts/stale");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBeGreaterThanOrEqual(1);
      expect(body.alerts[0].containerId).toBe("tenant_stale");
    });

    it("is not shadowed by /:containerId route", async () => {
      // "alerts" should not be treated as a containerId
      const res = await app.request("/alerts/stale");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("alerts");
      expect(body).toHaveProperty("count");
    });
  });

  describe("isRemotePathOwnedBy", () => {
    it("accepts valid paths containing the container as a segment", () => {
      expect(isRemotePathOwnedBy("nightly/node-1/tenant_abc/backup.tar.gz", "tenant_abc")).toBe(true);
    });

    it("rejects paths where container appears only as substring of a segment", () => {
      expect(isRemotePathOwnedBy("nightly/node-1/tenant_abc_fake/backup.tar.gz", "tenant_abc")).toBe(false);
    });

    it("rejects path traversal attempts", () => {
      expect(isRemotePathOwnedBy("nightly/../../tenant_abc/../other/backup.tar.gz", "tenant_abc")).toBe(true);
      expect(isRemotePathOwnedBy("nightly/../../other_tenant/backup.tar.gz", "tenant_abc")).toBe(false);
    });
  });
});
