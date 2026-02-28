import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import type { OrgInviteRow, OrgMemberRow } from "./org-member-repository.js";
import { DrizzleOrgMemberRepository } from "./org-member-repository.js";

describe("DrizzleOrgMemberRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleOrgMemberRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleOrgMemberRepository(db);
  });

  // -- Members --

  describe("addMember + findMember", () => {
    it("creates a member and retrieves it by orgId + userId", async () => {
      const member: OrgMemberRow = {
        id: "m-1",
        orgId: "org-A",
        userId: "user-1",
        role: "member",
        joinedAt: Date.now(),
      };
      await repo.addMember(member);
      const found = await repo.findMember("org-A", "user-1");
      expect(found).not.toBeNull();
      expect(found!.id).toBe("m-1");
      expect(found!.orgId).toBe("org-A");
      expect(found!.userId).toBe("user-1");
      expect(found!.role).toBe("member");
    });

    it("returns null when member does not exist", async () => {
      const found = await repo.findMember("org-A", "nonexistent");
      expect(found).toBeNull();
    });

    it("onConflictDoNothing when adding duplicate org+user", async () => {
      const member: OrgMemberRow = {
        id: "m-1",
        orgId: "org-A",
        userId: "user-1",
        role: "member",
        joinedAt: Date.now(),
      };
      await repo.addMember(member);
      // Add again with different role — should not throw, original preserved
      await repo.addMember({ ...member, id: "m-2", role: "admin" });
      const found = await repo.findMember("org-A", "user-1");
      expect(found!.role).toBe("member"); // original preserved
    });
  });

  describe("listMembers", () => {
    it("returns all members for the given org", async () => {
      await repo.addMember({ id: "m-1", orgId: "org-A", userId: "u-1", role: "member", joinedAt: Date.now() });
      await repo.addMember({ id: "m-2", orgId: "org-A", userId: "u-2", role: "admin", joinedAt: Date.now() });
      await repo.addMember({ id: "m-3", orgId: "org-B", userId: "u-3", role: "owner", joinedAt: Date.now() });

      const members = await repo.listMembers("org-A");
      expect(members).toHaveLength(2);
      expect(members.map((m) => m.userId).sort()).toEqual(["u-1", "u-2"]);
    });

    it("returns empty array for org with no members", async () => {
      const members = await repo.listMembers("empty-org");
      expect(members).toEqual([]);
    });
  });

  describe("updateMemberRole", () => {
    it("changes the role of an existing member", async () => {
      await repo.addMember({ id: "m-1", orgId: "org-A", userId: "u-1", role: "member", joinedAt: Date.now() });
      await repo.updateMemberRole("org-A", "u-1", "admin");
      const found = await repo.findMember("org-A", "u-1");
      expect(found!.role).toBe("admin");
    });
  });

  describe("removeMember", () => {
    it("removes a member and subsequent find returns null", async () => {
      await repo.addMember({ id: "m-1", orgId: "org-A", userId: "u-1", role: "member", joinedAt: Date.now() });
      await repo.removeMember("org-A", "u-1");
      const found = await repo.findMember("org-A", "u-1");
      expect(found).toBeNull();
    });

    it("does not throw when removing nonexistent member", async () => {
      await expect(repo.removeMember("org-A", "no-one")).resolves.toBeUndefined();
    });
  });

  describe("countAdminsAndOwners", () => {
    it("counts only admin and owner roles", async () => {
      await repo.addMember({ id: "m-1", orgId: "org-A", userId: "u-1", role: "member", joinedAt: Date.now() });
      await repo.addMember({ id: "m-2", orgId: "org-A", userId: "u-2", role: "admin", joinedAt: Date.now() });
      await repo.addMember({ id: "m-3", orgId: "org-A", userId: "u-3", role: "owner", joinedAt: Date.now() });

      const count = await repo.countAdminsAndOwners("org-A");
      expect(count).toBe(2);
    });

    it("returns 0 for org with no admins or owners", async () => {
      await repo.addMember({ id: "m-1", orgId: "org-A", userId: "u-1", role: "member", joinedAt: Date.now() });
      expect(await repo.countAdminsAndOwners("org-A")).toBe(0);
    });
  });

  describe("access control boundary", () => {
    it("member in org A is not found by org B query", async () => {
      await repo.addMember({ id: "m-1", orgId: "org-A", userId: "u-1", role: "admin", joinedAt: Date.now() });
      const found = await repo.findMember("org-B", "u-1");
      expect(found).toBeNull();
      const list = await repo.listMembers("org-B");
      expect(list).toEqual([]);
    });

    it("countAdminsAndOwners is scoped to the queried org", async () => {
      await repo.addMember({ id: "m-1", orgId: "org-A", userId: "u-1", role: "owner", joinedAt: Date.now() });
      await repo.addMember({ id: "m-2", orgId: "org-B", userId: "u-2", role: "owner", joinedAt: Date.now() });
      expect(await repo.countAdminsAndOwners("org-A")).toBe(1);
      expect(await repo.countAdminsAndOwners("org-B")).toBe(1);
    });
  });

  // -- Invites --

  describe("createInvite + findInviteById", () => {
    it("creates an invite and retrieves it by ID", async () => {
      const invite: OrgInviteRow = {
        id: "inv-1",
        orgId: "org-A",
        email: "alice@example.com",
        role: "member",
        invitedBy: "u-owner",
        token: "tok-abc",
        expiresAt: Date.now() + 86_400_000, // +1 day
        createdAt: Date.now(),
      };
      await repo.createInvite(invite);
      const found = await repo.findInviteById("inv-1");
      expect(found).not.toBeNull();
      expect(found!.email).toBe("alice@example.com");
      expect(found!.token).toBe("tok-abc");
    });

    it("returns null for nonexistent invite", async () => {
      expect(await repo.findInviteById("no-such")).toBeNull();
    });
  });

  describe("findInviteByToken", () => {
    it("retrieves invite by token", async () => {
      await repo.createInvite({
        id: "inv-1",
        orgId: "org-A",
        email: "bob@example.com",
        role: "admin",
        invitedBy: "u-owner",
        token: "tok-xyz",
        expiresAt: Date.now() + 86_400_000,
        createdAt: Date.now(),
      });
      const found = await repo.findInviteByToken("tok-xyz");
      expect(found).not.toBeNull();
      expect(found!.id).toBe("inv-1");
    });

    it("returns null for nonexistent token", async () => {
      expect(await repo.findInviteByToken("bad-token")).toBeNull();
    });
  });

  describe("listInvites", () => {
    it("returns only non-expired invites for the org", async () => {
      const now = Date.now();
      await repo.createInvite({
        id: "inv-1",
        orgId: "org-A",
        email: "a@a.com",
        role: "member",
        invitedBy: "u-1",
        token: "t-1",
        expiresAt: now + 86_400_000,
        createdAt: now,
      });
      await repo.createInvite({
        id: "inv-2",
        orgId: "org-A",
        email: "b@b.com",
        role: "member",
        invitedBy: "u-1",
        token: "t-2",
        expiresAt: now - 1000,
        createdAt: now, // expired
      });
      await repo.createInvite({
        id: "inv-3",
        orgId: "org-B",
        email: "c@c.com",
        role: "member",
        invitedBy: "u-2",
        token: "t-3",
        expiresAt: now + 86_400_000,
        createdAt: now, // different org
      });

      const invites = await repo.listInvites("org-A");
      expect(invites).toHaveLength(1);
      expect(invites[0].id).toBe("inv-1");
    });
  });

  describe("deleteInvite", () => {
    it("removes the invite", async () => {
      await repo.createInvite({
        id: "inv-1",
        orgId: "org-A",
        email: "a@a.com",
        role: "member",
        invitedBy: "u-1",
        token: "t-1",
        expiresAt: Date.now() + 86_400_000,
        createdAt: Date.now(),
      });
      await repo.deleteInvite("inv-1");
      expect(await repo.findInviteById("inv-1")).toBeNull();
    });
  });
});
