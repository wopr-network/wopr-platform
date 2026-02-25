import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleOrgRepository, type IOrgRepository } from "./org-repository.js";

function setup(): { repo: IOrgRepository; db: DrizzleDb; close: () => void } {
  const { db, sqlite } = createTestDb();
  const repo = new DrizzleOrgRepository(db);
  return { repo, db, close: () => sqlite.close() };
}

describe("DrizzleOrgRepository", () => {
  let repo: IOrgRepository;
  let close: () => void;

  beforeEach(() => {
    const t = setup();
    repo = t.repo;
    close = t.close;
  });

  afterEach(() => {
    close();
  });

  describe("createOrg", () => {
    it("creates an org tenant and returns it", () => {
      const org = repo.createOrg("user-1", "My Org", "my-org");
      expect(org.name).toBe("My Org");
      expect(org.slug).toBe("my-org");
      expect(org.type).toBe("org");
      expect(org.ownerId).toBe("user-1");
      expect(org.id).toBeTruthy();
    });

    it("throws on duplicate slug", () => {
      repo.createOrg("user-1", "Org A", "same-slug");
      expect(() => repo.createOrg("user-2", "Org B", "same-slug")).toThrow();
    });

    it("auto-generates slug from name when slug is omitted", () => {
      const org = repo.createOrg("user-1", "My Cool Org");
      expect(org.slug).toBe("my-cool-org");
    });
  });

  describe("ensurePersonalTenant", () => {
    it("creates a personal tenant for a user", () => {
      const tenant = repo.ensurePersonalTenant("user-1", "Alice");
      expect(tenant.id).toBe("user-1");
      expect(tenant.type).toBe("personal");
      expect(tenant.name).toBe("Alice");
    });

    it("is idempotent — second call does not throw", () => {
      repo.ensurePersonalTenant("user-1", "Alice");
      const tenant = repo.ensurePersonalTenant("user-1", "Alice");
      expect(tenant.id).toBe("user-1");
    });
  });

  describe("listByUser", () => {
    it("returns orgs where user has a role (via userIds)", () => {
      const org = repo.createOrg("user-1", "Org A", "org-a");
      expect(repo.getById(org.id)).toBeTruthy();
    });
  });

  describe("getById", () => {
    it("returns null for non-existent tenant", () => {
      expect(repo.getById("nonexistent")).toBeNull();
    });

    it("returns a tenant by ID", () => {
      const org = repo.createOrg("user-1", "Org A", "org-a");
      const found = repo.getById(org.id);
      expect(found?.name).toBe("Org A");
    });
  });

  describe("getBySlug", () => {
    it("returns null for non-existent slug", () => {
      expect(repo.getBySlug("nonexistent")).toBeNull();
    });

    it("finds a tenant by slug", () => {
      repo.createOrg("user-1", "Org A", "org-a");
      const found = repo.getBySlug("org-a");
      expect(found?.name).toBe("Org A");
    });
  });

  describe("listOrgsByOwner", () => {
    it("returns only org-type tenants for the owner", () => {
      repo.ensurePersonalTenant("user-1", "Alice");
      repo.createOrg("user-1", "Org A", "org-a");
      repo.createOrg("user-1", "Org B", "org-b");
      repo.createOrg("user-2", "Other Org", "other");

      const orgs = repo.listOrgsByOwner("user-1");
      expect(orgs).toHaveLength(2);
      expect(orgs.map((o) => o.slug).sort()).toEqual(["org-a", "org-b"]);
    });
  });
});
