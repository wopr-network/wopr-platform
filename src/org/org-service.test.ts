import type { PGlite } from "@electric-sql/pglite";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { DrizzleOrgMemberRepository } from "../fleet/org-member-repository.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleOrgRepository } from "./drizzle-org-repository.js";
import { OrgService } from "./org-service.js";

async function setup(db: DrizzleDb) {
  const orgRepo = new DrizzleOrgRepository(db);
  const memberRepo = new DrizzleOrgMemberRepository(db);
  const service = new OrgService(orgRepo, memberRepo, db);
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
    await pool.close().catch(() => {});
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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

  describe("createOrg", () => {
    it("happy path — creates org and owner membership", async () => {
      const owner = "owner-co1";
      const result = await service.createOrg(owner, "My Org", "my-org-co1");
      expect(result.id).toBeDefined();
      expect(result.name).toBe("My Org");
      expect(result.slug).toBe("my-org-co1");

      // Verify member row was created
      const { memberRepo } = await setup(db);
      const member = await memberRepo.findMember(result.id, owner);
      expect(member?.role).toBe("owner");
    });

    it("throws CONFLICT (TRPCError) when slug is already taken", async () => {
      await service.createOrg("user-a", "Org A", "taken-slug-co");
      const err = await service.createOrg("user-b", "Org B", "taken-slug-co").catch((e) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("CONFLICT");
    });

    it("throws CONFLICT (TRPCError) when DB unique constraint fires (race condition path)", async () => {
      // Simulate the race: getBySlug returns null (both concurrent requests passed the check),
      // but the DB insert fails with a unique constraint violation.
      const { orgRepo, memberRepo } = await setup(db);
      await orgRepo.createOrg("user-race", "Race Org", "race-slug-co");

      // Bypass the service-level slug check to reach the DB insert directly
      vi.spyOn(orgRepo, "getBySlug").mockResolvedValueOnce(null);
      const racingSvc = new OrgService(orgRepo, memberRepo, db);

      // This reaches the DB insert directly with the duplicate slug
      const err = await racingSvc.createOrg("user-race2", "Race Org 2", "race-slug-co").catch((e) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("CONFLICT");
    });

    it("throws BAD_REQUEST for invalid slug format", async () => {
      const err = await service.createOrg("user-c", "Org C", "INVALID_SLUG").catch((e) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("BAD_REQUEST");
    });

    it("partial failure — throws when addMember fails, org creation rolled back", async () => {
      const { orgRepo, memberRepo } = await setup(db);
      const failingMemberRepo = {
        ...memberRepo,
        addMember: async () => {
          throw new Error("addMember boom");
        },
      } as unknown as typeof memberRepo;
      const svc = new OrgService(orgRepo, failingMemberRepo, db);

      await expect(svc.createOrg("user-d", "Org D", "partial-fail-co")).rejects.toThrow("addMember boom");
      expect(await orgRepo.getBySlug("partial-fail-co")).toBeNull();
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
      const svc = new OrgService(orgRepo, memberRepo, db);
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
