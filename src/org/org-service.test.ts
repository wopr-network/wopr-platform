import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleOrgMemberRepository } from "../fleet/org-member-repository.js";
import { createTestDb } from "../test/db.js";
import { DrizzleOrgRepository } from "./drizzle-org-repository.js";
import { OrgService } from "./org-service.js";

function setup() {
  const { db, sqlite } = createTestDb();
  const orgRepo = new DrizzleOrgRepository(db);
  const memberRepo = new DrizzleOrgMemberRepository(db);
  const service = new OrgService(orgRepo, memberRepo);
  return { service, orgRepo, memberRepo, close: () => sqlite.close() };
}

describe("OrgService", () => {
  let service: OrgService;
  let close: () => void;
  const userId = "user-1";

  beforeEach(() => {
    const s = setup();
    service = s.service;
    close = s.close;
  });

  afterEach(() => {
    close();
  });

  describe("getOrCreatePersonalOrg", () => {
    it("creates personal org and owner member on first call", () => {
      const org = service.getOrCreatePersonalOrg(userId, "Alice");
      expect(org.type).toBe("personal");
      expect(org.ownerId).toBe(userId);
      expect(org.members).toHaveLength(1);
      expect(org.members[0].role).toBe("owner");
    });

    it("is idempotent — second call returns the same org", () => {
      service.getOrCreatePersonalOrg(userId, "Alice");
      const org = service.getOrCreatePersonalOrg(userId, "Alice");
      expect(org.members).toHaveLength(1);
    });
  });

  describe("updateOrg", () => {
    it("persists name change to DB", () => {
      // Create an org, then update it
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-1";
      const org = orgRepo.createOrg(owner, "Original", "original-slug");
      memberRepo.addMember({ id: "m1", orgId: org.id, userId: owner, role: "owner", joinedAt: Date.now() });

      const updated = svc.updateOrg(org.id, owner, { name: "Updated Name" });
      expect(updated.name).toBe("Updated Name");
      expect(updated.slug).toBe("original-slug"); // unchanged

      // Verify persisted
      const fetched = orgRepo.getById(org.id);
      expect(fetched?.name).toBe("Updated Name");
    });

    it("persists slug change to DB", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-2";
      const org = orgRepo.createOrg(owner, "My Org", "my-org");
      memberRepo.addMember({ id: "m2", orgId: org.id, userId: owner, role: "owner", joinedAt: Date.now() });

      const updated = svc.updateOrg(org.id, owner, { slug: "new-slug-ab" });
      expect(updated.slug).toBe("new-slug-ab");

      const fetched = orgRepo.getById(org.id);
      expect(fetched?.slug).toBe("new-slug-ab");
    });

    it("throws FORBIDDEN when non-admin tries to update", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-3";
      const org = orgRepo.createOrg(owner, "Org", "org-slug");
      memberRepo.addMember({ id: "m3", orgId: org.id, userId: owner, role: "owner", joinedAt: Date.now() });

      expect(() => svc.updateOrg(org.id, "not-a-member", { name: "hack" })).toThrow();
    });

    it("throws CONFLICT when slug is already taken", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-4";
      orgRepo.createOrg("other", "Other Org", "taken-slug");
      const org = orgRepo.createOrg(owner, "My Org", "mine-slug");
      memberRepo.addMember({ id: "m4", orgId: org.id, userId: owner, role: "owner", joinedAt: Date.now() });

      expect(() => svc.updateOrg(org.id, owner, { slug: "taken-slug" })).toThrow();
    });
  });

  describe("transferOwnership", () => {
    it("updates member roles AND persists new ownerId to tenants table", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-5";
      const newOwner = "new-owner-5";
      const org = orgRepo.createOrg(owner, "Transfer Org", "transfer-org");
      memberRepo.addMember({ id: "m5", orgId: org.id, userId: owner, role: "owner", joinedAt: Date.now() });
      memberRepo.addMember({ id: "m6", orgId: org.id, userId: newOwner, role: "member", joinedAt: Date.now() });

      svc.transferOwnership(org.id, owner, newOwner);

      const updatedOrg = orgRepo.getById(org.id);
      expect(updatedOrg?.ownerId).toBe(newOwner);

      const newOwnerMember = memberRepo.findMember(org.id, newOwner);
      expect(newOwnerMember?.role).toBe("owner");

      const oldOwnerMember = memberRepo.findMember(org.id, owner);
      expect(oldOwnerMember?.role).toBe("admin");
    });

    it("throws FORBIDDEN if non-owner tries to transfer", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-6";
      const other = "other-6";
      const org = orgRepo.createOrg(owner, "Org6", "org6");
      memberRepo.addMember({ id: "m7", orgId: org.id, userId: owner, role: "owner", joinedAt: Date.now() });
      memberRepo.addMember({ id: "m8", orgId: org.id, userId: other, role: "admin", joinedAt: Date.now() });

      expect(() => svc.transferOwnership(org.id, other, owner)).toThrow();
    });

    it("throws NOT_FOUND if target member does not exist", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-7";
      const org = orgRepo.createOrg(owner, "Org7", "org7");
      memberRepo.addMember({ id: "m9", orgId: org.id, userId: owner, role: "owner", joinedAt: Date.now() });

      expect(() => svc.transferOwnership(org.id, owner, "nonexistent")).toThrow();
    });
  });

  describe("validateSlug", () => {
    it("accepts a valid slug", () => {
      expect(() => service.validateSlug("valid-slug-12")).not.toThrow();
    });

    it("rejects a slug with invalid characters", () => {
      expect(() => service.validateSlug("UPPERCASE")).toThrow();
    });

    it("rejects a slug that is too short", () => {
      expect(() => service.validateSlug("ab")).toThrow();
    });
  });
});
