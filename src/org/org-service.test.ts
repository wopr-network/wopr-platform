import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { DrizzleOrgMemberRepository } from "../fleet/org-member-repository.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleOrgRepository } from "./drizzle-org-repository.js";
import { OrgService } from "./org-service.js";

async function setup(db: DrizzleDb) {
  const orgRepo = new DrizzleOrgRepository(db);
  const memberRepo = new DrizzleOrgMemberRepository(db);
  const service = new OrgService(orgRepo, memberRepo);
  return { service, orgRepo, memberRepo };
}

describe("OrgService", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let service: OrgService;
  const userId = "user-1";

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    ({ service } = await setup(db));
  });

  describe("getOrCreatePersonalOrg", () => {
    it("creates personal org and owner member on first call", async () => {
      const org = await service.getOrCreatePersonalOrg(userId, "Alice");
      expect(org.type).toBe("personal");
      expect(org.ownerId).toBe(userId);
      expect(org.members).toHaveLength(1);
      expect(org.members[0].role).toBe("owner");
    });

    it("is idempotent — second call returns the same org", async () => {
      await service.getOrCreatePersonalOrg(userId, "Alice");
      const org = await service.getOrCreatePersonalOrg(userId, "Alice");
      expect(org.members).toHaveLength(1);
    });
  });

  describe("updateOrg", () => {
    it("persists name change to DB", async () => {
      // Create an org, then update it
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-1";
      const org = await orgRepo.createOrg(owner, "Original", "original-slug");
      await memberRepo.addMember({
        id: "m1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      const updated = await svc.updateOrg(org.id, owner, { name: "Updated Name" });
      expect(updated.name).toBe("Updated Name");
      expect(updated.slug).toBe("original-slug"); // unchanged

      // Verify persisted
      const fetched = await orgRepo.getById(org.id);
      expect(fetched?.name).toBe("Updated Name");
    });

    it("persists slug change to DB", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-2";
      const org = await orgRepo.createOrg(owner, "My Org", "my-org");
      await memberRepo.addMember({
        id: "m2",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      const updated = await svc.updateOrg(org.id, owner, { slug: "new-slug-ab" });
      expect(updated.slug).toBe("new-slug-ab");

      const fetched = await orgRepo.getById(org.id);
      expect(fetched?.slug).toBe("new-slug-ab");
    });

    it("throws FORBIDDEN when non-admin tries to update", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-3";
      const org = await orgRepo.createOrg(owner, "Org", "org-slug");
      await memberRepo.addMember({
        id: "m3",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      await expect(svc.updateOrg(org.id, "not-a-member", { name: "hack" })).rejects.toThrow();
    });

    it("throws CONFLICT when slug is already taken", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-4";
      await orgRepo.createOrg("other", "Other Org", "taken-slug");
      const org = await orgRepo.createOrg(owner, "My Org", "mine-slug");
      await memberRepo.addMember({
        id: "m4",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      await expect(svc.updateOrg(org.id, owner, { slug: "taken-slug" })).rejects.toThrow();
    });
  });

  describe("transferOwnership", () => {
    it("updates member roles AND persists new ownerId to tenants table", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-5";
      const newOwner = "new-owner-5";
      const org = await orgRepo.createOrg(owner, "Transfer Org", "transfer-org");
      await memberRepo.addMember({
        id: "m5",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      await memberRepo.addMember({
        id: "m6",
        orgId: org.id,
        userId: newOwner,
        role: "member",
        joinedAt: Date.now(),
      });

      await svc.transferOwnership(org.id, owner, newOwner);

      const updatedOrg = await orgRepo.getById(org.id);
      expect(updatedOrg?.ownerId).toBe(newOwner);

      const newOwnerMember = await memberRepo.findMember(org.id, newOwner);
      expect(newOwnerMember?.role).toBe("owner");

      const oldOwnerMember = await memberRepo.findMember(org.id, owner);
      expect(oldOwnerMember?.role).toBe("admin");
    });

    it("throws FORBIDDEN if non-owner tries to transfer", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-6";
      const other = "other-6";
      const org = await orgRepo.createOrg(owner, "Org6", "org6");
      await memberRepo.addMember({
        id: "m7",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      await memberRepo.addMember({
        id: "m8",
        orgId: org.id,
        userId: other,
        role: "admin",
        joinedAt: Date.now(),
      });

      await expect(svc.transferOwnership(org.id, other, owner)).rejects.toThrow();
    });

    it("throws NOT_FOUND if target member does not exist", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-7";
      const org = await orgRepo.createOrg(owner, "Org7", "org7");
      await memberRepo.addMember({
        id: "m9",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      await expect(svc.transferOwnership(org.id, owner, "nonexistent")).rejects.toThrow();
    });
  });

  describe("validateSlug", () => {
    it("accepts a valid slug", async () => {
      expect(() => service.validateSlug("valid-slug-12")).not.toThrow();
    });

    it("rejects a slug with invalid characters", async () => {
      expect(() => service.validateSlug("UPPERCASE")).toThrow();
    });

    it("rejects a slug that is too short", async () => {
      expect(() => service.validateSlug("ab")).toThrow();
    });
  });

  describe("getOrg", () => {
    it("returns org with members and invites", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-g1";
      const org = await orgRepo.createOrg(owner, "Get Org", "get-org");
      await memberRepo.addMember({
        id: "mg1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      const result = await svc.getOrg(org.id);
      expect(result.id).toBe(org.id);
      expect(result.members).toHaveLength(1);
      expect(result.invites).toHaveLength(0);
    });

    it("throws NOT_FOUND for unknown org", async () => {
      await expect(service.getOrg("nonexistent")).rejects.toThrow();
    });
  });

  describe("deleteOrg", () => {
    it("deletes org when called by owner", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-d1";
      const org = await orgRepo.createOrg(owner, "Del Org", "del-org");
      await memberRepo.addMember({
        id: "md1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      await svc.deleteOrg(org.id, owner);

      // Org should be gone
      const found = await orgRepo.getById(org.id);
      expect(found).toBeNull();
      // Members should be gone
      const members = await memberRepo.listMembers(org.id);
      expect(members).toHaveLength(0);
    });

    it("deletes org with members and invites", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-d3";
      const member = "member-d3";
      const org = await orgRepo.createOrg(owner, "Del Org 3", "del-org-3");
      await memberRepo.addMember({
        id: "md4",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      await memberRepo.addMember({
        id: "md5",
        orgId: org.id,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      });
      await memberRepo.createInvite({
        id: "inv-d3",
        orgId: org.id,
        email: "invited@example.com",
        role: "member",
        invitedBy: owner,
        token: "tok-d3",
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now(),
      });

      await svc.deleteOrg(org.id, owner);

      expect(await orgRepo.getById(org.id)).toBeNull();
      expect(await memberRepo.listMembers(org.id)).toHaveLength(0);
    });

    it("throws FORBIDDEN when non-owner tries to delete", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-d1b";
      const other = "other-d1b";
      const org = await orgRepo.createOrg(owner, "Del Org B", "del-org-b");
      await memberRepo.addMember({
        id: "md1b",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      await memberRepo.addMember({
        id: "md2b",
        orgId: org.id,
        userId: other,
        role: "admin",
        joinedAt: Date.now(),
      });

      await expect(svc.deleteOrg(org.id, other)).rejects.toThrow();
    });

    it("throws NOT_FOUND for nonexistent org", async () => {
      await expect(service.deleteOrg("nonexistent", userId)).rejects.toThrow();
    });
  });

  describe("inviteMember", () => {
    it("creates an invite and returns it", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-i1";
      const org = await orgRepo.createOrg(owner, "Invite Org", "invite-org");
      await memberRepo.addMember({
        id: "mi1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      const invite = await svc.inviteMember(org.id, owner, "new@example.com", "member");
      expect(invite.email).toBe("new@example.com");
      expect(invite.role).toBe("member");
    });

    it("throws FORBIDDEN when non-admin invites", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-i2";
      const org = await orgRepo.createOrg(owner, "Org I2", "org-i2");
      await memberRepo.addMember({
        id: "mi2",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      await expect(svc.inviteMember(org.id, "stranger", "x@x.com", "member")).rejects.toThrow();
    });
  });

  describe("revokeInvite", () => {
    it("revokes an existing invite", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-r1";
      const org = await orgRepo.createOrg(owner, "Revoke Org", "revoke-org");
      await memberRepo.addMember({
        id: "mr1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      const invite = await svc.inviteMember(org.id, owner, "rev@example.com", "member");

      await expect(svc.revokeInvite(org.id, owner, invite.id)).resolves.not.toThrow();
    });

    it("throws NOT_FOUND for unknown invite", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-r2";
      const org = await orgRepo.createOrg(owner, "Revoke Org 2", "revoke-org-2");
      await memberRepo.addMember({
        id: "mr2",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      await expect(svc.revokeInvite(org.id, owner, "nonexistent-invite")).rejects.toThrow();
    });
  });

  describe("changeRole", () => {
    it("changes a member's role", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-c1";
      const member = "member-c1";
      const org = await orgRepo.createOrg(owner, "Change Org", "change-org");
      await memberRepo.addMember({
        id: "mc1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      await memberRepo.addMember({
        id: "mc2",
        orgId: org.id,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      });

      await expect(svc.changeRole(org.id, owner, member, "admin")).resolves.not.toThrow();
      expect((await memberRepo.findMember(org.id, member))?.role).toBe("admin");
    });

    it("throws BAD_REQUEST when trying to change owner's role", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-c2";
      const org = await orgRepo.createOrg(owner, "Change Org 2", "change-org-2");
      await memberRepo.addMember({
        id: "mc3",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      await expect(svc.changeRole(org.id, owner, owner, "admin")).rejects.toThrow();
    });

    it("throws NOT_FOUND when target member does not exist", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-c3";
      const org = await orgRepo.createOrg(owner, "Change Org 3", "change-org-3");
      await memberRepo.addMember({
        id: "mc4",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      await expect(svc.changeRole(org.id, owner, "nobody", "admin")).rejects.toThrow();
    });
  });

  describe("removeMember", () => {
    it("removes a regular member", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-rm1";
      const member = "member-rm1";
      const org = await orgRepo.createOrg(owner, "Remove Org", "remove-org");
      await memberRepo.addMember({
        id: "mrm1",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      await memberRepo.addMember({
        id: "mrm2",
        orgId: org.id,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      });

      await expect(svc.removeMember(org.id, owner, member)).resolves.not.toThrow();
    });

    it("throws BAD_REQUEST when trying to remove the owner", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-rm2";
      const org = await orgRepo.createOrg(owner, "Remove Org 2", "remove-org-2");
      await memberRepo.addMember({
        id: "mrm3",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      await expect(svc.removeMember(org.id, owner, owner)).rejects.toThrow();
    });

    it("throws NOT_FOUND when target member does not exist", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-rm3";
      const org = await orgRepo.createOrg(owner, "Remove Org 3", "remove-org-3");
      await memberRepo.addMember({
        id: "mrm4",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });

      await expect(svc.removeMember(org.id, owner, "nobody")).rejects.toThrow();
    });

    it("allows removing an admin when the owner is still present (count > 1)", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const svc = new OrgService(orgRepo, memberRepo);
      const owner = "owner-rm4";
      const admin = "admin-rm4";
      const org = await orgRepo.createOrg(owner, "Remove Org 4", "remove-org-4");
      await memberRepo.addMember({
        id: "mrm5",
        orgId: org.id,
        userId: owner,
        role: "owner",
        joinedAt: Date.now(),
      });
      await memberRepo.addMember({
        id: "mrm6",
        orgId: org.id,
        userId: admin,
        role: "admin",
        joinedAt: Date.now(),
      });

      // Owner counts as admin/owner too (count = 2), so removing the admin succeeds
      await expect(svc.removeMember(org.id, owner, admin)).resolves.not.toThrow();
    });
  });
});
