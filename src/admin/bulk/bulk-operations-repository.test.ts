import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { adminUsers } from "../../db/schema/admin-users.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { DrizzleBulkOperationsRepository } from "./bulk-operations-repository.js";

let pool: PGlite;
let db: DrizzleDb;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

describe("DrizzleBulkOperationsRepository", () => {
  let repo: DrizzleBulkOperationsRepository;

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleBulkOperationsRepository(db);

    const now = Date.now();
    await db.insert(adminUsers).values([
      {
        id: "u1",
        email: "alice@test.com",
        name: "Alice",
        tenantId: "tenant-1",
        status: "active",
        role: "user",
        creditBalanceCents: 1000,
        agentCount: 2,
        createdAt: now,
      },
      {
        id: "u2",
        email: "bob@test.com",
        name: "Bob",
        tenantId: "tenant-2",
        status: "active",
        role: "user",
        creditBalanceCents: 500,
        agentCount: 1,
        createdAt: now,
      },
      {
        id: "u3",
        email: "carol@test.com",
        name: "Carol",
        tenantId: "tenant-3",
        status: "suspended",
        role: "user",
        creditBalanceCents: 0,
        agentCount: 0,
        createdAt: now,
      },
      {
        id: "u4",
        email: "dave@test.com",
        name: "Dave",
        tenantId: "tenant-4",
        status: "active",
        role: "tenant_admin",
        creditBalanceCents: 200,
        agentCount: 3,
        createdAt: now,
      },
    ]);
  });

  describe("lookupTenants", () => {
    it("returns tenant info for valid IDs", async () => {
      const result = await repo.lookupTenants(["tenant-1", "tenant-2"]);
      expect(result).toHaveLength(2);
      const t1 = result.find((r) => r.tenantId === "tenant-1");
      expect(t1).toBeDefined();
      expect(t1?.name).toBe("Alice");
      expect(t1?.email).toBe("alice@test.com");
      expect(t1?.status).toBe("active");
    });

    it("returns empty array for empty input", async () => {
      const result = await repo.lookupTenants([]);
      expect(result).toEqual([]);
    });

    it("skips nonexistent tenant IDs", async () => {
      const result = await repo.lookupTenants(["tenant-1", "nonexistent"]);
      expect(result).toHaveLength(1);
      expect(result[0].tenantId).toBe("tenant-1");
    });
  });

  describe("lookupTenantsForExport", () => {
    it("returns full AdminUserRow fields", async () => {
      const result = await repo.lookupTenantsForExport(["tenant-1"]);
      expect(result).toHaveLength(1);
      expect(result[0].tenantId).toBe("tenant-1");
      expect(result[0].name).toBe("Alice");
      expect(result[0].email).toBe("alice@test.com");
      expect(result[0].status).toBe("active");
      expect(result[0].role).toBe("user");
      expect(result[0].creditBalanceCents).toBe(1000);
      expect(result[0].agentCount).toBe(2);
      expect(result[0].createdAt).toBeGreaterThan(0);
    });

    it("returns empty array for empty input", async () => {
      const result = await repo.lookupTenantsForExport([]);
      expect(result).toEqual([]);
    });

    it("orders by createdAt descending", async () => {
      const now = Date.now();
      await db.insert(adminUsers).values({
        id: "u5",
        email: "eve@test.com",
        name: "Eve",
        tenantId: "tenant-5",
        status: "active",
        role: "user",
        creditBalanceCents: 0,
        agentCount: 0,
        createdAt: now + 10000,
      });
      const result = await repo.lookupTenantsForExport(["tenant-1", "tenant-5"]);
      expect(result).toHaveLength(2);
      expect(result[0].tenantId).toBe("tenant-5");
    });
  });

  describe("listMatchingTenantIds", () => {
    it("filters by status", async () => {
      const ids = await repo.listMatchingTenantIds({ status: "active" });
      expect(ids).toContain("tenant-1");
      expect(ids).toContain("tenant-2");
      expect(ids).toContain("tenant-4");
      expect(ids).not.toContain("tenant-3");
    });

    it("filters by role", async () => {
      const ids = await repo.listMatchingTenantIds({ role: "tenant_admin" });
      expect(ids).toEqual(["tenant-4"]);
    });

    it("filters by search (name match)", async () => {
      const ids = await repo.listMatchingTenantIds({ search: "alice" });
      expect(ids).toEqual(["tenant-1"]);
    });

    it("filters by search (email match)", async () => {
      const ids = await repo.listMatchingTenantIds({ search: "bob@test" });
      expect(ids).toEqual(["tenant-2"]);
    });

    it("filters by hasCredits true", async () => {
      const ids = await repo.listMatchingTenantIds({ hasCredits: true });
      expect(ids).toContain("tenant-1");
      expect(ids).toContain("tenant-2");
      expect(ids).toContain("tenant-4");
      expect(ids).not.toContain("tenant-3");
    });

    it("filters by hasCredits false", async () => {
      const ids = await repo.listMatchingTenantIds({ hasCredits: false });
      expect(ids).toContain("tenant-3");
      expect(ids).not.toContain("tenant-1");
    });

    it("filters by lowBalance", async () => {
      const ids = await repo.listMatchingTenantIds({ lowBalance: true });
      // lowBalance = creditBalanceCents < 500: tenant-3 (0), tenant-4 (200)
      expect(ids).toContain("tenant-3");
      expect(ids).toContain("tenant-4");
      expect(ids).not.toContain("tenant-1");
    });

    it("returns all IDs with no filters", async () => {
      const ids = await repo.listMatchingTenantIds({});
      expect(ids).toHaveLength(4);
    });

    it("combines multiple filters", async () => {
      const ids = await repo.listMatchingTenantIds({ status: "active", lowBalance: true });
      // active + < 500 cents: tenant-4 (200)
      expect(ids).toEqual(["tenant-4"]);
    });
  });

  describe("undoable grants", () => {
    const grant = {
      operationId: "op-1",
      tenantIds: '["tenant-1","tenant-2"]',
      amountCents: 500,
      adminUser: "admin-1",
      createdAt: Date.now(),
      undoDeadline: Date.now() + 300000,
      undone: false,
    };

    it("insertUndoableGrant + getUndoableGrant round-trips correctly", async () => {
      await repo.insertUndoableGrant(grant);
      const result = await repo.getUndoableGrant("op-1");

      expect(result).not.toBeNull();
      expect(result?.operationId).toBe("op-1");
      expect(result?.tenantIds).toBe('["tenant-1","tenant-2"]');
      expect(result?.amountCents).toBe(500);
      expect(result?.adminUser).toBe("admin-1");
      expect(result?.createdAt).toBe(grant.createdAt);
      expect(result?.undoDeadline).toBe(grant.undoDeadline);
      expect(result?.undone).toBe(false);
    });

    it("getUndoableGrant returns null for nonexistent ID", async () => {
      const result = await repo.getUndoableGrant("nonexistent");
      expect(result).toBeNull();
    });

    it("markGrantUndone sets undone to true", async () => {
      await repo.insertUndoableGrant(grant);
      await repo.markGrantUndone("op-1");

      const result = await repo.getUndoableGrant("op-1");
      expect(result?.undone).toBe(true);
    });
  });
});
