/**
 * OrgService — business logic for org member management, invite lifecycle,
 * role changes, and org CRUD. Depends on IOrgRepository (tenant data) and
 * IOrgMemberRepository (members/invites data).
 */

import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import type { IOrgMemberRepository, OrgInviteRow } from "../fleet/org-member-repository.js";
import type { IOrgRepository, Tenant } from "./drizzle-org-repository.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrgWithMembers extends Tenant {
  members: OrgMemberWithUser[];
  invites: OrgInvitePublic[];
}

export interface OrgMemberWithUser {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
}

export interface OrgInvitePublic {
  id: string;
  email: string;
  role: "admin" | "member";
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class OrgService {
  constructor(
    private readonly orgRepo: IOrgRepository,
    private readonly memberRepo: IOrgMemberRepository,
  ) {}

  /**
   * Return the personal org for the user, creating it if it doesn't exist.
   * "Personal org" = the user's personal tenant (type="personal").
   */
  async getOrCreatePersonalOrg(userId: string, displayName: string): Promise<OrgWithMembers> {
    const tenant = await this.orgRepo.ensurePersonalTenant(userId, displayName);
    // Ensure the owner member row exists. Use addMember (which uses ON CONFLICT DO NOTHING)
    // unconditionally to handle concurrent calls that may race past findMember.
    await this.memberRepo.addMember({
      id: crypto.randomUUID(),
      orgId: tenant.id,
      userId,
      role: "owner",
      joinedAt: Date.now(),
    });
    return this.buildOrgWithMembers(tenant);
  }

  /** Get an org's details, including member/invite lists. */
  async getOrg(orgId: string): Promise<OrgWithMembers> {
    const tenant = await this.requireOrg(orgId);
    return this.buildOrgWithMembers(tenant);
  }

  async updateOrg(orgId: string, actorUserId: string, data: { name?: string; slug?: string }): Promise<Tenant> {
    await this.requireAdminOrOwner(orgId, actorUserId);
    if (data.slug !== undefined) {
      this.validateSlug(data.slug);
      const existing = await this.orgRepo.getBySlug(data.slug);
      if (existing && existing.id !== orgId) {
        throw new TRPCError({ code: "CONFLICT", message: "Slug already taken" });
      }
    }
    return this.orgRepo.updateOrg(orgId, data);
  }

  async deleteOrg(orgId: string, actorUserId: string): Promise<void> {
    const org = await this.requireOrg(orgId);
    if (org.ownerId !== actorUserId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner can delete the organization" });
    }
    // cascade handled by DB FK; just delete the tenant
    // NOTE: The existing IOrgRepository has no delete method yet.
    // This is a no-op until extended — throw NOT_IMPLEMENTED for now.
    throw new TRPCError({ code: "METHOD_NOT_SUPPORTED", message: "Org deletion requires IOrgRepository.deleteOrg" });
  }

  async inviteMember(
    orgId: string,
    actorUserId: string,
    email: string,
    role: "admin" | "member",
  ): Promise<OrgInviteRow> {
    await this.requireAdminOrOwner(orgId, actorUserId);
    const token = crypto.randomBytes(32).toString("hex");
    const invite: OrgInviteRow = {
      id: crypto.randomUUID(),
      orgId,
      email,
      role,
      invitedBy: actorUserId,
      token,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
    };
    await this.memberRepo.createInvite(invite);
    return invite;
  }

  async revokeInvite(orgId: string, actorUserId: string, inviteId: string): Promise<void> {
    await this.requireAdminOrOwner(orgId, actorUserId);
    const invite = await this.memberRepo.findInviteById(inviteId);
    if (!invite || invite.orgId !== orgId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
    }
    await this.memberRepo.deleteInvite(inviteId);
  }

  async changeRole(
    orgId: string,
    actorUserId: string,
    targetUserId: string,
    newRole: "admin" | "member",
  ): Promise<void> {
    await this.requireAdminOrOwner(orgId, actorUserId);
    const org = await this.requireOrg(orgId);
    if (org.ownerId === targetUserId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot change the owner's role. Use transfer ownership instead.",
      });
    }
    const member = await this.memberRepo.findMember(orgId, targetUserId);
    if (!member) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    }
    await this.memberRepo.updateMemberRole(orgId, targetUserId, newRole);
  }

  async removeMember(orgId: string, actorUserId: string, targetUserId: string): Promise<void> {
    await this.requireAdminOrOwner(orgId, actorUserId);
    const org = await this.requireOrg(orgId);
    if (org.ownerId === targetUserId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot remove the owner" });
    }
    const member = await this.memberRepo.findMember(orgId, targetUserId);
    if (!member) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    }
    if (member.role === "admin") {
      const count = await this.memberRepo.countAdminsAndOwners(orgId);
      if (count <= 1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot remove the last admin" });
      }
    }
    await this.memberRepo.removeMember(orgId, targetUserId);
  }

  async transferOwnership(orgId: string, actorUserId: string, targetUserId: string): Promise<void> {
    const org = await this.requireOrg(orgId);
    if (org.ownerId !== actorUserId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner can transfer ownership" });
    }
    const target = await this.memberRepo.findMember(orgId, targetUserId);
    if (!target) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Target member not found" });
    }
    await this.memberRepo.updateMemberRole(orgId, targetUserId, "owner");
    await this.memberRepo.updateMemberRole(orgId, actorUserId, "admin");
    await this.orgRepo.updateOwner(orgId, targetUserId);
  }

  validateSlug(slug: string): void {
    if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(slug)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Slug must be 3-48 characters, lowercase alphanumeric and hyphens, cannot start/end with a hyphen",
      });
    }
  }

  private async buildOrgWithMembers(tenant: Tenant): Promise<OrgWithMembers> {
    const members = await this.memberRepo.listMembers(tenant.id);
    const invites = await this.memberRepo.listInvites(tenant.id);
    return {
      ...tenant,
      members: members.map((m) => ({
        id: m.id,
        userId: m.userId,
        name: m.userId, // name resolved from user context (placeholder until user profile lookup wired)
        email: "", // email resolved from user context (placeholder)
        role: m.role,
        joinedAt: new Date(m.joinedAt).toISOString(),
      })),
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        invitedBy: i.invitedBy,
        expiresAt: new Date(i.expiresAt).toISOString(),
        createdAt: new Date(i.createdAt).toISOString(),
      })),
    };
  }

  private async requireOrg(orgId: string): Promise<Tenant> {
    const org = await this.orgRepo.getById(orgId);
    if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });
    return org;
  }

  private async requireAdminOrOwner(orgId: string, userId: string): Promise<void> {
    const member = await this.memberRepo.findMember(orgId, userId);
    if (!member || (member.role !== "admin" && member.role !== "owner")) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Admin or owner role required" });
    }
  }
}
