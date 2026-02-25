/**
 * Repository for organization members and invites.
 *
 * Follows the mandatory repository pattern: IOrgMemberRepository interface +
 * DrizzleOrgMemberRepository implementation in the same file.
 * See: src/fleet/bot-instance-repository.ts
 */

import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { organizationInvites, organizationMembers } from "../db/schema/organization-members.js";

// ---------------------------------------------------------------------------
// Domain types (no Drizzle imports)
// ---------------------------------------------------------------------------

export interface OrgMemberRow {
  id: string;
  orgId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  joinedAt: number;
}

export interface OrgInviteRow {
  id: string;
  orgId: string;
  email: string;
  role: "admin" | "member";
  invitedBy: string;
  token: string;
  expiresAt: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IOrgMemberRepository {
  listMembers(orgId: string): OrgMemberRow[];
  addMember(member: OrgMemberRow): void;
  updateMemberRole(orgId: string, userId: string, role: "owner" | "admin" | "member"): void;
  removeMember(orgId: string, userId: string): void;
  findMember(orgId: string, userId: string): OrgMemberRow | null;
  countAdminsAndOwners(orgId: string): number;

  listInvites(orgId: string): OrgInviteRow[];
  createInvite(invite: OrgInviteRow): void;
  findInviteById(inviteId: string): OrgInviteRow | null;
  findInviteByToken(token: string): OrgInviteRow | null;
  deleteInvite(inviteId: string): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function toMember(row: typeof organizationMembers.$inferSelect): OrgMemberRow {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    role: row.role as "owner" | "admin" | "member",
    joinedAt: row.joinedAt,
  };
}

function toInvite(row: typeof organizationInvites.$inferSelect): OrgInviteRow {
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    role: row.role as "admin" | "member",
    invitedBy: row.invitedBy,
    token: row.token,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleOrgMemberRepository implements IOrgMemberRepository {
  constructor(private readonly db: DrizzleDb) {}

  listMembers(orgId: string): OrgMemberRow[] {
    return this.db.select().from(organizationMembers).where(eq(organizationMembers.orgId, orgId)).all().map(toMember);
  }

  addMember(member: OrgMemberRow): void {
    this.db.insert(organizationMembers).values(member).run();
  }

  updateMemberRole(orgId: string, userId: string, role: "owner" | "admin" | "member"): void {
    this.db
      .update(organizationMembers)
      .set({ role })
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .run();
  }

  removeMember(orgId: string, userId: string): void {
    this.db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .run();
  }

  findMember(orgId: string, userId: string): OrgMemberRow | null {
    const row = this.db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .get();
    return row ? toMember(row) : null;
  }

  countAdminsAndOwners(orgId: string): number {
    return this.listMembers(orgId).filter((m) => m.role === "admin" || m.role === "owner").length;
  }

  listInvites(orgId: string): OrgInviteRow[] {
    const now = Date.now();
    return this.db
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.orgId, orgId))
      .all()
      .filter((r) => r.expiresAt > now)
      .map(toInvite);
  }

  createInvite(invite: OrgInviteRow): void {
    this.db.insert(organizationInvites).values(invite).run();
  }

  findInviteById(inviteId: string): OrgInviteRow | null {
    const row = this.db.select().from(organizationInvites).where(eq(organizationInvites.id, inviteId)).get();
    return row ? toInvite(row) : null;
  }

  findInviteByToken(token: string): OrgInviteRow | null {
    const row = this.db.select().from(organizationInvites).where(eq(organizationInvites.token, token)).get();
    return row ? toInvite(row) : null;
  }

  deleteInvite(inviteId: string): void {
    this.db.delete(organizationInvites).where(eq(organizationInvites.id, inviteId)).run();
  }
}
