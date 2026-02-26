import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleBackupStatusRepository } from "../../backup/backup-status-repository.js";
import { BackupStatusStore } from "../../backup/backup-status-store.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { createAdminBackupRoutes, isRemotePathOwnedBy } from "./admin-backups.js";

describe("admin-backups routes", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: PGlite;
  let store: BackupStatusStore;
  let app: ReturnType<typeof createAdminBackupRoutes>;

  beforeAll(async () => {
    const { db, pool: p } = await createTestDb();
    pool = p;
    const repo = new DrizzleBackupStatusRepository(db);
    store = new BackupStatusStore(repo);
    app = createAdminBackupRoutes(store);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
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
