import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleAdminAuditLogRepository } from "../../admin/admin-audit-log-repository.js";
import { AdminAuditLog } from "../../admin/audit-log.js";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { createAdminAuditApiRoutes } from "./admin-audit.js";

describe("admin-audit routes", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let auditLog: AdminAuditLog;
  let app: ReturnType<typeof createAdminAuditApiRoutes>;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    const repo = new DrizzleAdminAuditLogRepository(db);
    auditLog = new AdminAuditLog(repo);
    app = createAdminAuditApiRoutes(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  // GET /

  describe("GET /", () => {
    it("returns empty entries when no audit log exists", async () => {
      const res = await app.request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns audit entries after logging", async () => {
      await auditLog.log({
        adminUser: "admin-1",
        action: "credits.grant",
        category: "credits",
        targetTenant: "tenant-a",
        details: { amount_cents: 500 },
        outcome: "success",
      });

      const res = await app.request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.entries[0]).toHaveProperty("admin_user", "admin-1");
      expect(body.entries[0]).toHaveProperty("action", "credits.grant");
    });

    it("filters by admin query param", async () => {
      await auditLog.log({
        adminUser: "admin-x",
        action: "role.set",
        category: "roles",
        details: {},
        outcome: "success",
      });
      await auditLog.log({
        adminUser: "admin-y",
        action: "note.create",
        category: "support",
        details: {},
        outcome: "success",
      });

      const res = await app.request("/?admin=admin-x");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.entries[0].admin_user).toBe("admin-x");
    });

    it("filters by action query param", async () => {
      await auditLog.log({
        adminUser: "admin-1",
        action: "credits.grant",
        category: "credits",
        details: {},
        outcome: "success",
      });
      await auditLog.log({
        adminUser: "admin-1",
        action: "credits.refund",
        category: "credits",
        details: {},
        outcome: "success",
      });

      const res = await app.request("/?action=credits.grant");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.entries[0].action).toBe("credits.grant");
    });

    it("filters by category query param", async () => {
      await auditLog.log({
        adminUser: "admin-1",
        action: "credits.grant",
        category: "credits",
        details: {},
        outcome: "success",
      });
      await auditLog.log({
        adminUser: "admin-1",
        action: "role.set",
        category: "roles",
        details: {},
        outcome: "success",
      });

      const res = await app.request("/?category=roles");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.entries[0].category).toBe("roles");
    });

    it("filters by tenant query param", async () => {
      await auditLog.log({
        adminUser: "admin-1",
        action: "credits.grant",
        category: "credits",
        targetTenant: "tenant-1",
        details: {},
        outcome: "success",
      });
      await auditLog.log({
        adminUser: "admin-1",
        action: "credits.grant",
        category: "credits",
        targetTenant: "tenant-2",
        details: {},
        outcome: "success",
      });

      const res = await app.request("/?tenant=tenant-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.entries[0].target_tenant).toBe("tenant-1");
    });

    it("accepts limit and offset params", async () => {
      const res = await app.request("/?limit=10&offset=0");
      expect(res.status).toBe(200);
    });
  });

  // GET /export

  describe("GET /export", () => {
    it("returns CSV content-type", async () => {
      const res = await app.request("/export");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
    });

    it("includes content-disposition header for download", async () => {
      const res = await app.request("/export");
      expect(res.headers.get("content-disposition")).toContain("audit-log.csv");
    });

    it("CSV includes header row", async () => {
      const res = await app.request("/export");
      const text = await res.text();
      expect(text).toContain("admin_user");
    });

    it("CSV includes data rows when entries exist", async () => {
      await auditLog.log({
        adminUser: "admin-csv",
        action: "credits.grant",
        category: "credits",
        targetTenant: "tenant-csv",
        details: { amount_cents: 100 },
        outcome: "success",
      });

      const res = await app.request("/export");
      const text = await res.text();
      expect(text).toContain("admin-csv");
    });

    it("accepts filter query params", async () => {
      const res = await app.request("/export?admin=admin-1&action=credits.grant");
      expect(res.status).toBe(200);
    });
  });
});
