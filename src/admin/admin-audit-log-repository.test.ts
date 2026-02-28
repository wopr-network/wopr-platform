import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleAdminAuditLogRepository } from "./admin-audit-log-repository.js";
import type { AdminAuditLogRow } from "./audit-log.js";

let pool: PGlite;
let db: DrizzleDb;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

function makeRow(overrides: Partial<AdminAuditLogRow> = {}): AdminAuditLogRow {
  return {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    admin_user: "admin-1",
    action: "user.suspend",
    category: "account",
    target_tenant: "tenant-1",
    target_user: "user-42",
    details: '{"reason":"ToS violation"}',
    ip_address: "10.0.0.1",
    user_agent: "AdminPanel/1.0",
    created_at: Date.now(),
    outcome: null,
    ...overrides,
  };
}

describe("DrizzleAdminAuditLogRepository", () => {
  let repo: DrizzleAdminAuditLogRepository;

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleAdminAuditLogRepository(db);
  });

  describe("insert", () => {
    it("inserts a row and retrieves it via query", async () => {
      const row = makeRow();
      await repo.insert(row);

      const result = await repo.query({});
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].id).toBe(row.id);
      expect(result.entries[0].admin_user).toBe("admin-1");
      expect(result.entries[0].action).toBe("user.suspend");
      expect(result.entries[0].category).toBe("account");
      expect(result.entries[0].target_tenant).toBe("tenant-1");
      expect(result.entries[0].target_user).toBe("user-42");
      expect(result.entries[0].details).toBe('{"reason":"ToS violation"}');
      expect(result.entries[0].ip_address).toBe("10.0.0.1");
      expect(result.entries[0].user_agent).toBe("AdminPanel/1.0");
      expect(result.entries[0].created_at).toBe(row.created_at);
      expect(result.entries[0].outcome).toBeNull();
    });

    it("stores outcome field when provided", async () => {
      const row = makeRow({ outcome: "success" });
      await repo.insert(row);

      const result = await repo.query({});
      expect(result.entries[0].outcome).toBe("success");
    });

    it("handles null optional fields", async () => {
      const row = makeRow({
        target_tenant: null,
        target_user: null,
        ip_address: null,
        user_agent: null,
      });
      await repo.insert(row);

      const result = await repo.query({});
      expect(result.entries[0].target_tenant).toBeNull();
      expect(result.entries[0].target_user).toBeNull();
      expect(result.entries[0].ip_address).toBeNull();
      expect(result.entries[0].user_agent).toBeNull();
    });
  });

  describe("query", () => {
    it("filters by admin", async () => {
      await repo.insert(makeRow({ id: "a1", admin_user: "admin-1" }));
      await repo.insert(makeRow({ id: "a2", admin_user: "admin-2" }));

      const result = await repo.query({ admin: "admin-1" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].admin_user).toBe("admin-1");
      expect(result.total).toBe(1);
    });

    it("filters by action", async () => {
      await repo.insert(makeRow({ id: "a1", action: "user.suspend" }));
      await repo.insert(makeRow({ id: "a2", action: "credits.add" }));

      const result = await repo.query({ action: "user.suspend" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].action).toBe("user.suspend");
    });

    it("filters by category", async () => {
      await repo.insert(makeRow({ id: "a1", category: "account" }));
      await repo.insert(makeRow({ id: "a2", category: "credits", action: "credits.add" }));

      const result = await repo.query({ category: "credits" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].category).toBe("credits");
    });

    it("filters by tenant", async () => {
      await repo.insert(makeRow({ id: "a1", target_tenant: "tenant-1" }));
      await repo.insert(makeRow({ id: "a2", target_tenant: "tenant-2" }));

      const result = await repo.query({ tenant: "tenant-1" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].target_tenant).toBe("tenant-1");
    });

    it("filters by date range lower bound", async () => {
      const now = Date.now();
      await repo.insert(makeRow({ id: "old", created_at: now - 100000 }));
      await repo.insert(makeRow({ id: "new", created_at: now }));

      const result = await repo.query({ from: now - 5000 });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].id).toBe("new");
    });

    it("filters by date range upper bound", async () => {
      const now = Date.now();
      await repo.insert(makeRow({ id: "old", created_at: now - 100000 }));
      await repo.insert(makeRow({ id: "new", created_at: now }));

      const result = await repo.query({ to: now - 50000 });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].id).toBe("old");
    });

    it("combines multiple filters", async () => {
      await repo.insert(makeRow({ id: "a1", admin_user: "admin-1", category: "account" }));
      await repo.insert(makeRow({ id: "a2", admin_user: "admin-1", category: "credits", action: "credits.add" }));
      await repo.insert(makeRow({ id: "a3", admin_user: "admin-2", category: "account" }));

      const result = await repo.query({ admin: "admin-1", category: "account" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].id).toBe("a1");
    });

    it("paginates with limit and offset", async () => {
      for (let i = 0; i < 10; i++) {
        await repo.insert(makeRow({ id: `a${i}`, created_at: Date.now() + i }));
      }

      const page1 = await repo.query({ limit: 3, offset: 0 });
      expect(page1.entries).toHaveLength(3);
      expect(page1.total).toBe(10);

      const page2 = await repo.query({ limit: 3, offset: 3 });
      expect(page2.entries).toHaveLength(3);
      expect(page2.entries[0].id).not.toBe(page1.entries[0].id);
    });

    it("caps limit at 250", async () => {
      for (let i = 0; i < 5; i++) {
        await repo.insert(makeRow({ id: `a${i}` }));
      }
      const result = await repo.query({ limit: 999 });
      expect(result.entries).toHaveLength(5);
    });

    it("defaults limit to 50", async () => {
      const result = await repo.query({});
      expect(result.total).toBe(0);
    });

    it("orders by created_at descending", async () => {
      const now = Date.now();
      await repo.insert(makeRow({ id: "first", created_at: now - 1000 }));
      await repo.insert(makeRow({ id: "second", created_at: now }));

      const result = await repo.query({});
      expect(result.entries[0].id).toBe("second");
      expect(result.entries[1].id).toBe("first");
    });

    it("returns empty when no entries match", async () => {
      const result = await repo.query({ admin: "nonexistent" });
      expect(result.entries).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe("queryAll", () => {
    it("returns all matching entries without pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await repo.insert(makeRow({ id: `a${i}`, admin_user: "admin-1" }));
      }
      await repo.insert(makeRow({ id: "other", admin_user: "admin-2" }));

      const result = await repo.queryAll({ admin: "admin-1" });
      expect(result).toHaveLength(5);
      expect(result.every((r) => r.admin_user === "admin-1")).toBe(true);
    });

    it("returns all entries when no filters", async () => {
      for (let i = 0; i < 3; i++) {
        await repo.insert(makeRow({ id: `a${i}` }));
      }
      const result = await repo.queryAll({});
      expect(result).toHaveLength(3);
    });

    it("orders by created_at descending", async () => {
      const now = Date.now();
      await repo.insert(makeRow({ id: "first", created_at: now - 1000 }));
      await repo.insert(makeRow({ id: "second", created_at: now }));

      const result = await repo.queryAll({});
      expect(result[0].id).toBe("second");
      expect(result[1].id).toBe("first");
    });
  });
});
