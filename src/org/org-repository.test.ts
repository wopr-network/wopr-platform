import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleOrgRepository, type IOrgRepository } from "./drizzle-org-repository.js";

let db: DrizzleDb;
let pool: PGlite;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
});

afterAll(async () => {
  await pool.close();
});

describe("DrizzleOrgRepository", () => {
  let repo: IOrgRepository;

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleOrgRepository(db);
  });

  describe("createOrg", () => {
    it("creates an org tenant and returns it", async () => {
      const org = await repo.createOrg("user-1", "My Org", "my-org");
      expect(org.name).toBe("My Org");
      expect(org.slug).toBe("my-org");
      expect(org.type).toBe("org");
      expect(org.ownerId).toBe("user-1");
      expect(org.id).toBeTruthy();
    });

    it("throws on duplicate slug", async () => {
      await repo.createOrg("user-1", "Org A", "same-slug");
      await expect(repo.createOrg("user-2", "Org B", "same-slug")).rejects.toThrow();
    });

    it("auto-generates slug from name when slug is omitted", async () => {
      const org = await repo.createOrg("user-1", "My Cool Org");
      expect(org.slug).toBe("my-cool-org");
    });
  });

  describe("ensurePersonalTenant", () => {
    it("creates a personal tenant for a user", async () => {
      const tenant = await repo.ensurePersonalTenant("user-1", "Alice");
      expect(tenant.id).toBe("user-1");
      expect(tenant.type).toBe("personal");
      expect(tenant.name).toBe("Alice");
    });

    it("is idempotent — second call does not throw", async () => {
      await repo.ensurePersonalTenant("user-1", "Alice");
      const tenant = await repo.ensurePersonalTenant("user-1", "Alice");
      expect(tenant.id).toBe("user-1");
    });
  });

  describe("listByUser", () => {
    it("returns orgs where user has a role (via userIds)", async () => {
      const org = await repo.createOrg("user-1", "Org A", "org-a");
      expect(await repo.getById(org.id)).toBeTruthy();
    });
  });

  describe("getById", () => {
    it("returns null for non-existent tenant", async () => {
      expect(await repo.getById("nonexistent")).toBeNull();
    });

    it("returns a tenant by ID", async () => {
      const org = await repo.createOrg("user-1", "Org A", "org-a");
      const found = await repo.getById(org.id);
      expect(found?.name).toBe("Org A");
    });
  });

  describe("getBySlug", () => {
    it("returns null for non-existent slug", async () => {
      expect(await repo.getBySlug("nonexistent")).toBeNull();
    });

    it("finds a tenant by slug", async () => {
      await repo.createOrg("user-1", "Org A", "org-a");
      const found = await repo.getBySlug("org-a");
      expect(found?.name).toBe("Org A");
    });
  });

  describe("listOrgsByOwner", () => {
    it("returns only org-type tenants for the owner", async () => {
      await repo.ensurePersonalTenant("user-1", "Alice");
      await repo.createOrg("user-1", "Org A", "org-a");
      await repo.createOrg("user-1", "Org B", "org-b");
      await repo.createOrg("user-2", "Other Org", "other");

      const orgs = await repo.listOrgsByOwner("user-1");
      expect(orgs).toHaveLength(2);
      expect(orgs.map((o) => o.slug).sort()).toEqual(["org-a", "org-b"]);
    });

    it("returns empty array when owner has no orgs", async () => {
      const orgs = await repo.listOrgsByOwner("nobody");
      expect(orgs).toHaveLength(0);
    });
  });

  describe("createOrg (edge cases)", () => {
    it("throws when name produces an empty slug", async () => {
      await expect(repo.createOrg("user-1", "---")).rejects.toThrow(/empty slug/);
    });
  });

  describe("updateOrg", () => {
    it("updates name and returns updated tenant", async () => {
      const org = await repo.createOrg("user-1", "Original", "original");
      const updated = await repo.updateOrg(org.id, { name: "Renamed" });
      expect(updated.name).toBe("Renamed");
      expect(updated.slug).toBe("original");
    });

    it("updates slug and returns updated tenant", async () => {
      const org = await repo.createOrg("user-1", "Org", "old-slug");
      const updated = await repo.updateOrg(org.id, { slug: "new-slug" });
      expect(updated.slug).toBe("new-slug");
    });

    it("throws when org not found", async () => {
      await expect(repo.updateOrg("nonexistent-id", { name: "X" })).rejects.toThrow(/not found/);
    });
  });

  describe("updateOwner", () => {
    it("persists the new ownerId", async () => {
      const org = await repo.createOrg("user-1", "Org", "org-slug");
      await repo.updateOwner(org.id, "user-2");
      const updated = await repo.getById(org.id);
      expect(updated?.ownerId).toBe("user-2");
    });
  });
});
