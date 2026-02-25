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
      memberRepo.addMember({
        id: "m1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

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
      memberRepo.addMember({
        id: "m2",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

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
      memberRepo.addMember({
        id: "m3",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      expect(() => svc.updateOrg(org.id, "not-a-member", { name: "hack" })).toThrow();
    });

    it("throws CONFLICT when slug is already taken", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-4";
      orgRepo.createOrg("other", "Other Org", "taken-slug");
      const org = orgRepo.createOrg(owner, "My Org", "mine-slug");
      memberRepo.addMember({
        id: "m4",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

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
      memberRepo.addMember({
        id: "m5",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      memberRepo.addMember({
        id: "m6",
        orgId: org.id,
        userId: newOwner,
        role: "member",
        joinedAt: Date.now(),
      });

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
      memberRepo.addMember({
        id: "m7",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      memberRepo.addMember({
        id: "m8",
        orgId: org.id,
        userId: other,
        role: "admin",
        joinedAt: Date.now(),
      });

      expect(() => svc.transferOwnership(org.id, other, owner)).toThrow();
    });

    it("throws NOT_FOUND if target member does not exist", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-7";
      const org = orgRepo.createOrg(owner, "Org7", "org7");
      memberRepo.addMember({
        id: "m9",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

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

  describe("getOrg", () => {
    it("returns org with members and invites", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-g1";
      const org = orgRepo.createOrg(owner, "Get Org", "get-org");
      memberRepo.addMember({
        id: "mg1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      const result = svc.getOrg(org.id);
      expect(result.id).toBe(org.id);
      expect(result.members).toHaveLength(1);
      expect(result.invites).toHaveLength(0);
    });

    it("throws NOT_FOUND for unknown org", () => {
      expect(() => service.getOrg("nonexistent")).toThrow();
    });
  });

  describe("deleteOrg", () => {
    it("throws FORBIDDEN when non-owner tries to delete", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-d1";
      const other = "other-d1";
      const org = orgRepo.createOrg(owner, "Del Org", "del-org");
      memberRepo.addMember({
        id: "md1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      memberRepo.addMember({
        id: "md2",
        orgId: org.id,
        userId: other,
        role: "admin",
        joinedAt: Date.now(),
      });

      expect(() => svc.deleteOrg(org.id, other)).toThrow();
    });

    it("throws METHOD_NOT_SUPPORTED for owner (delete not implemented)", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-d2";
      const org = orgRepo.createOrg(owner, "Del Org 2", "del-org-2");
      memberRepo.addMember({
        id: "md3",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      expect(() => svc.deleteOrg(org.id, owner)).toThrow();
    });
  });

  describe("inviteMember", () => {
    it("creates an invite and returns it", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-i1";
      const org = orgRepo.createOrg(owner, "Invite Org", "invite-org");
      memberRepo.addMember({
        id: "mi1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      const invite = svc.inviteMember(org.id, owner, "new@example.com", "member");
      expect(invite.email).toBe("new@example.com");
      expect(invite.role).toBe("member");
    });

    it("throws FORBIDDEN when non-admin invites", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-i2";
      const org = orgRepo.createOrg(owner, "Org I2", "org-i2");
      memberRepo.addMember({
        id: "mi2",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      expect(() => svc.inviteMember(org.id, "stranger", "x@x.com", "member")).toThrow();
    });
  });

  describe("revokeInvite", () => {
    it("revokes an existing invite", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-r1";
      const org = orgRepo.createOrg(owner, "Revoke Org", "revoke-org");
      memberRepo.addMember({
        id: "mr1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      const invite = svc.inviteMember(org.id, owner, "rev@example.com", "member");

      expect(() => svc.revokeInvite(org.id, owner, invite.id)).not.toThrow();
    });

    it("throws NOT_FOUND for unknown invite", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-r2";
      const org = orgRepo.createOrg(owner, "Revoke Org 2", "revoke-org-2");
      memberRepo.addMember({
        id: "mr2",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      expect(() => svc.revokeInvite(org.id, owner, "nonexistent-invite")).toThrow();
    });
  });

  describe("changeRole", () => {
    it("changes a member's role", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-c1";
      const member = "member-c1";
      const org = orgRepo.createOrg(owner, "Change Org", "change-org");
      memberRepo.addMember({
        id: "mc1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      memberRepo.addMember({
        id: "mc2",
        orgId: org.id,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      });

      expect(() => svc.changeRole(org.id, owner, member, "admin")).not.toThrow();
      expect(memberRepo.findMember(org.id, member)?.role).toBe("admin");
    });

    it("throws BAD_REQUEST when trying to change owner's role", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-c2";
      const org = orgRepo.createOrg(owner, "Change Org 2", "change-org-2");
      memberRepo.addMember({
        id: "mc3",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      expect(() => svc.changeRole(org.id, owner, owner, "admin")).toThrow();
    });

    it("throws NOT_FOUND when target member does not exist", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-c3";
      const org = orgRepo.createOrg(owner, "Change Org 3", "change-org-3");
      memberRepo.addMember({
        id: "mc4",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      expect(() => svc.changeRole(org.id, owner, "nobody", "admin")).toThrow();
    });
  });

  describe("removeMember", () => {
    it("removes a regular member", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-rm1";
      const member = "member-rm1";
      const org = orgRepo.createOrg(owner, "Remove Org", "remove-org");
      memberRepo.addMember({
        id: "mrm1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      memberRepo.addMember({
        id: "mrm2",
        orgId: org.id,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      });

      expect(() => svc.removeMember(org.id, owner, member)).not.toThrow();
    });

    it("throws BAD_REQUEST when trying to remove the owner", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-rm2";
      const org = orgRepo.createOrg(owner, "Remove Org 2", "remove-org-2");
      memberRepo.addMember({
        id: "mrm3",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      expect(() => svc.removeMember(org.id, owner, owner)).toThrow();
    });

    it("throws NOT_FOUND when target member does not exist", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-rm3";
      const org = orgRepo.createOrg(owner, "Remove Org 3", "remove-org-3");
      memberRepo.addMember({
        id: "mrm4",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      expect(() => svc.removeMember(org.id, owner, "nobody")).toThrow();
    });

    it("allows removing an admin when the owner is still present (count > 1)", () => {
      const { orgRepo, memberRepo } = setup();
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-rm4";
      const admin = "admin-rm4";
      const org = orgRepo.createOrg(owner, "Remove Org 4", "remove-org-4");
      memberRepo.addMember({
        id: "mrm5",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      memberRepo.addMember({
        id: "mrm6",
        orgId: org.id,
        userId: admin,
        role: "admin",
        joinedAt: Date.now(),
      });

      // Owner counts as admin/owner too (count = 2), so removing the admin succeeds
      expect(() => svc.removeMember(org.id, owner, admin)).not.toThrow();
    });
  });
});
