import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { orgMemberships } from "../db/schema/org-memberships.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleOrgMembershipRepository } from "./org-membership-repository.js";

describe("DrizzleOrgMembershipRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleOrgMembershipRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleOrgMembershipRepository(db);
  });

  describe("getOrgTenantIdForMember", () => {
    it("returns the org tenant ID when a membership exists", async () => {
      await db.insert(orgMemberships).values({
        orgTenantId: "org-tenant-1",
        memberTenantId: "member-tenant-1",
        createdAt: Date.now(),
      });

      const result = await repo.getOrgTenantIdForMember("member-tenant-1");
      expect(result).toBe("org-tenant-1");
    });

    it("returns null when no membership exists", async () => {
      const result = await repo.getOrgTenantIdForMember("nonexistent");
      expect(result).toBeNull();
    });

    it("returns correct org when multiple memberships exist for different members", async () => {
      await db.insert(orgMemberships).values([
        { orgTenantId: "org-A", memberTenantId: "member-1", createdAt: Date.now() },
        { orgTenantId: "org-B", memberTenantId: "member-2", createdAt: Date.now() },
      ]);

      expect(await repo.getOrgTenantIdForMember("member-1")).toBe("org-A");
      expect(await repo.getOrgTenantIdForMember("member-2")).toBe("org-B");
    });

    it("access control boundary: member of org A does not resolve to org B", async () => {
      await db.insert(orgMemberships).values({
        orgTenantId: "org-A",
        memberTenantId: "member-1",
        createdAt: Date.now(),
      });

      // member-1 belongs to org-A, not org-B
      const result = await repo.getOrgTenantIdForMember("member-1");
      expect(result).toBe("org-A");
      expect(result).not.toBe("org-B");

      // member-2 has no membership at all
      expect(await repo.getOrgTenantIdForMember("member-2")).toBeNull();
    });

    it("deletion is reflected in subsequent reads", async () => {
      await db.insert(orgMemberships).values({
        orgTenantId: "org-A",
        memberTenantId: "member-1",
        createdAt: Date.now(),
      });

      expect(await repo.getOrgTenantIdForMember("member-1")).toBe("org-A");

      // Delete directly via Drizzle (repo has no delete method — it's read-only)
      const { eq } = await import("drizzle-orm");
      await db.delete(orgMemberships).where(eq(orgMemberships.memberTenantId, "member-1"));

      expect(await repo.getOrgTenantIdForMember("member-1")).toBeNull();
    });
  });
});
