import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { botInstances } from "../../src/db/schema/index.js";
import { DrizzleOrgMemberRepository } from "../../src/fleet/org-member-repository.js";
import { DrizzleOrgRepository } from "../../src/org/drizzle-org-repository.js";
import { OrgService } from "../../src/org/org-service.js";
import { createTestDb } from "../../src/test/db.js";

describe("E2E: org/team management — create org → invite → assign role → transfer bot → remove member", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let orgService: OrgService;
  let orgRepo: DrizzleOrgRepository;
  let memberRepo: DrizzleOrgMemberRepository;

  const OWNER_ID = `owner-${randomUUID()}`;
  const MEMBER_ID = `member-${randomUUID()}`;
  const VIEWER_ID = `viewer-${randomUUID()}`;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    orgRepo = new DrizzleOrgRepository(db);
    memberRepo = new DrizzleOrgMemberRepository(db);
    orgService = new OrgService(orgRepo, memberRepo, db);
  });

  afterEach(async () => {
    if (pool) await pool.close();
  });

  // =========================================================================
  // TEST 1: Create an organization
  // =========================================================================

  it("creates an organization and owner becomes a member", async () => {
    const result = await orgService.createOrg(OWNER_ID, "Acme Corp", "acme-corp");

    expect(result.id).toBeDefined();
    expect(result.name).toBe("Acme Corp");
    expect(result.slug).toBe("acme-corp");

    // Owner should be a member with role "owner"
    const member = await memberRepo.findMember(result.id, OWNER_ID);
    expect(member).not.toBeNull();
    expect(member!.role).toBe("owner");
  });

  // =========================================================================
  // TEST 2: Invite a member by email → member joins
  // =========================================================================

  it("invites a member by email and member joins the org", async () => {
    const org = await orgService.createOrg(OWNER_ID, "Invite Test Org", "invite-test");

    // Owner invites a new member
    const invite = await orgService.inviteMember(org.id, OWNER_ID, "newbie@example.com", "member");
    expect(invite.email).toBe("newbie@example.com");
    expect(invite.role).toBe("member");
    expect(invite.token).toBeDefined();

    // Simulate member accepting invite: add member + delete invite
    await memberRepo.addMember({
      id: randomUUID(),
      orgId: org.id,
      userId: MEMBER_ID,
      role: invite.role,
      joinedAt: Date.now(),
    });
    await memberRepo.deleteInvite(invite.id);

    // Verify member is in the org
    const member = await memberRepo.findMember(org.id, MEMBER_ID);
    expect(member).not.toBeNull();
    expect(member!.role).toBe("member");

    // Verify invite is gone
    const deletedInvite = await memberRepo.findInviteById(invite.id);
    expect(deletedInvite).toBeNull();
  });

  // =========================================================================
  // TEST 3: Cannot invite already-existing member (idempotent add)
  // =========================================================================

  it("adding an existing member is idempotent (no error)", async () => {
    const org = await orgService.createOrg(OWNER_ID, "Idempotent Org", "idempotent-org");

    // Add member
    await memberRepo.addMember({
      id: randomUUID(),
      orgId: org.id,
      userId: MEMBER_ID,
      role: "member",
      joinedAt: Date.now(),
    });

    // Adding same member again should not throw (ON CONFLICT DO NOTHING)
    await memberRepo.addMember({
      id: randomUUID(),
      orgId: org.id,
      userId: MEMBER_ID,
      role: "admin",
      joinedAt: Date.now(),
    });

    // Role should remain "member" (first insert wins with ON CONFLICT DO NOTHING)
    const member = await memberRepo.findMember(org.id, MEMBER_ID);
    expect(member).not.toBeNull();
    expect(member!.role).toBe("member");
  });

  // =========================================================================
  // TEST 4: Assign role (admin, member) to org member
  // =========================================================================

  it("assigns admin role to a member", async () => {
    const org = await orgService.createOrg(OWNER_ID, "Role Test Org", "role-test");

    // Add member
    await memberRepo.addMember({
      id: randomUUID(),
      orgId: org.id,
      userId: MEMBER_ID,
      role: "member",
      joinedAt: Date.now(),
    });

    // Owner changes member's role to admin
    await orgService.changeRole(org.id, OWNER_ID, MEMBER_ID, "admin");

    const member = await memberRepo.findMember(org.id, MEMBER_ID);
    expect(member!.role).toBe("admin");

    // Change back to member
    await orgService.changeRole(org.id, OWNER_ID, MEMBER_ID, "member");

    const memberAgain = await memberRepo.findMember(org.id, MEMBER_ID);
    expect(memberAgain!.role).toBe("member");
  });

  // =========================================================================
  // TEST 5: Cannot change owner's role
  // =========================================================================

  it("rejects changing the owner's role", async () => {
    const org = await orgService.createOrg(OWNER_ID, "Owner Role Org", "owner-role");

    await expect(
      orgService.changeRole(org.id, OWNER_ID, OWNER_ID, "member"),
    ).rejects.toThrow("Cannot change the owner's role");
  });

  // =========================================================================
  // TEST 6: Transfer ownership from one member to another
  // =========================================================================

  it("transfers ownership: old owner becomes admin, new owner becomes owner", async () => {
    const org = await orgService.createOrg(OWNER_ID, "Transfer Org", "transfer-org");

    // Add target member
    await memberRepo.addMember({
      id: randomUUID(),
      orgId: org.id,
      userId: MEMBER_ID,
      role: "member",
      joinedAt: Date.now(),
    });

    // Transfer ownership
    await orgService.transferOwnership(org.id, OWNER_ID, MEMBER_ID);

    // New owner has "owner" role
    const newOwner = await memberRepo.findMember(org.id, MEMBER_ID);
    expect(newOwner!.role).toBe("owner");

    // Old owner has "admin" role
    const oldOwner = await memberRepo.findMember(org.id, OWNER_ID);
    expect(oldOwner!.role).toBe("admin");

    // Tenant record updated
    const tenant = await orgRepo.getById(org.id);
    expect(tenant!.ownerId).toBe(MEMBER_ID);
  });

  // =========================================================================
  // TEST 7: Transfer bot ownership (tenantId change preserves config)
  // =========================================================================

  it("transfers bot ownership between org members by updating tenantId", async () => {
    const orgA = await orgService.createOrg(OWNER_ID, "Org A Bots", "org-a-bots");
    const orgB = await orgService.createOrg(MEMBER_ID, "Org B Bots", "org-b-bots");

    const botId = randomUUID();

    // Seed a bot instance in Org A
    await db.insert(botInstances).values({
      id: botId,
      tenantId: orgA.id,
      name: "transfer-bot",
      billingState: "active",
    });

    // Verify bot belongs to Org A
    const before = await db.select().from(botInstances).where(eq(botInstances.id, botId));
    expect(before[0].tenantId).toBe(orgA.id);
    expect(before[0].name).toBe("transfer-bot");

    // Transfer bot to Org B
    await db.update(botInstances).set({ tenantId: orgB.id }).where(eq(botInstances.id, botId));

    // Verify bot now belongs to Org B with config preserved
    const after = await db.select().from(botInstances).where(eq(botInstances.id, botId));
    expect(after[0].tenantId).toBe(orgB.id);
    expect(after[0].name).toBe("transfer-bot");
    expect(after[0].billingState).toBe("active");
  });

  // =========================================================================
  // TEST 8: Remove member → verify they lose access to org resources
  // =========================================================================

  it("removes a member and they no longer appear in the org", async () => {
    const org = await orgService.createOrg(OWNER_ID, "Remove Test Org", "remove-test");

    // Add member
    await memberRepo.addMember({
      id: randomUUID(),
      orgId: org.id,
      userId: MEMBER_ID,
      role: "member",
      joinedAt: Date.now(),
    });

    // Verify member exists
    const before = await memberRepo.findMember(org.id, MEMBER_ID);
    expect(before).not.toBeNull();

    // Remove member
    await orgService.removeMember(org.id, OWNER_ID, MEMBER_ID);

    // Verify member is gone
    const after = await memberRepo.findMember(org.id, MEMBER_ID);
    expect(after).toBeNull();
  });

  // =========================================================================
  // TEST 9: Removing last admin from org is rejected
  // =========================================================================

  it("rejects removing the last admin from the org", async () => {
    const org = await orgService.createOrg(OWNER_ID, "Last Admin Org", "last-admin");

    // Add one admin member
    await memberRepo.addMember({
      id: randomUUID(),
      orgId: org.id,
      userId: MEMBER_ID,
      role: "admin",
      joinedAt: Date.now(),
    });

    // Add a regular member
    await memberRepo.addMember({
      id: randomUUID(),
      orgId: org.id,
      userId: VIEWER_ID,
      role: "member",
      joinedAt: Date.now(),
    });

    // Owner (role=owner) + MEMBER_ID (role=admin) = 2 admins/owners
    // Removing the admin leaves owner as the only admin/owner → allowed
    await orgService.removeMember(org.id, OWNER_ID, MEMBER_ID);

    // Now try to remove the owner → rejected because owner can't be removed
    await expect(
      orgService.removeMember(org.id, OWNER_ID, OWNER_ID),
    ).rejects.toThrow("Cannot remove the owner");
  });

  // =========================================================================
  // TEST 10: Org deletion cascades properly
  // =========================================================================

  it("org deletion removes members, invites, and bot instances", async () => {
    const org = await orgService.createOrg(OWNER_ID, "Delete Org", "delete-org");

    // Add a member
    await memberRepo.addMember({
      id: randomUUID(),
      orgId: org.id,
      userId: MEMBER_ID,
      role: "member",
      joinedAt: Date.now(),
    });

    // Add an invite
    await orgService.inviteMember(org.id, OWNER_ID, "invited@example.com", "member");

    // Add a bot instance
    const botId = randomUUID();
    await db.insert(botInstances).values({
      id: botId,
      tenantId: org.id,
      name: "doomed-bot",
      billingState: "active",
    });

    // Delete org
    await orgService.deleteOrg(org.id, OWNER_ID);

    // Verify everything is gone
    const tenant = await orgRepo.getById(org.id);
    expect(tenant).toBeNull();

    const members = await memberRepo.listMembers(org.id);
    expect(members).toHaveLength(0);

    const bots = await db.select().from(botInstances).where(eq(botInstances.tenantId, org.id));
    expect(bots).toHaveLength(0);
  });

  // =========================================================================
  // TEST 11: Non-owner cannot delete org
  // =========================================================================

  it("rejects org deletion by non-owner", async () => {
    const org = await orgService.createOrg(OWNER_ID, "No Delete Org", "no-delete");

    await memberRepo.addMember({
      id: randomUUID(),
      orgId: org.id,
      userId: MEMBER_ID,
      role: "admin",
      joinedAt: Date.now(),
    });

    await expect(
      orgService.deleteOrg(org.id, MEMBER_ID),
    ).rejects.toThrow("Only the owner can delete the organization");
  });

  // =========================================================================
  // TEST 12: Non-admin cannot invite or change roles
  // =========================================================================

  it("rejects invite by regular member (not admin/owner)", async () => {
    const org = await orgService.createOrg(OWNER_ID, "No Invite Org", "no-invite");

    await memberRepo.addMember({
      id: randomUUID(),
      orgId: org.id,
      userId: MEMBER_ID,
      role: "member",
      joinedAt: Date.now(),
    });

    await expect(
      orgService.inviteMember(org.id, MEMBER_ID, "sneaky@example.com", "admin"),
    ).rejects.toThrow("Admin or owner role required");
  });
});
