/**
 * Repository for organization members and invites.
 *
 * Follows the mandatory repository pattern: IOrgMemberRepository interface +
 * DrizzleOrgMemberRepository implementation in the same file.
 * See: src/fleet/bot-instance-repository.ts
 */

import { and, eq, gt, inArray } from "drizzle-orm";
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
  listMembers(orgId: string): Promise<OrgMemberRow[]>;
  addMember(member: OrgMemberRow): Promise<void>;
  updateMemberRole(orgId: string, userId: string, role: "owner" | "admin" | "member"): Promise<void>;
  removeMember(orgId: string, userId: string): Promise<void>;
  findMember(orgId: string, userId: string): Promise<OrgMemberRow | null>;
  countAdminsAndOwners(orgId: string): Promise<number>;

  listInvites(orgId: string): Promise<OrgInviteRow[]>;
  createInvite(invite: OrgInviteRow): Promise<void>;
  findInviteById(inviteId: string): Promise<OrgInviteRow | null>;
  findInviteByToken(token: string): Promise<OrgInviteRow | null>;
  deleteInvite(inviteId: string): Promise<void>;
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

  async listMembers(orgId: string): Promise<OrgMemberRow[]> {
    const rows = await this.db.select().from(organizationMembers).where(eq(organizationMembers.orgId, orgId));
    return rows.map(toMember);
  }

  async addMember(member: OrgMemberRow): Promise<void> {
    await this.db.insert(organizationMembers).values(member).onConflictDoNothing();
  }

  async updateMemberRole(orgId: string, userId: string, role: "owner" | "admin" | "member"): Promise<void> {
    await this.db
      .update(organizationMembers)
      .set({ role })
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  }

  async removeMember(orgId: string, userId: string): Promise<void> {
    await this.db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  }

  async findMember(orgId: string, userId: string): Promise<OrgMemberRow | null> {
    const rows = await this.db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
    return rows[0] ? toMember(rows[0]) : null;
  }

  async countAdminsAndOwners(orgId: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.role, ["admin", "owner"])));
    return rows.length;
  }

  async listInvites(orgId: string): Promise<OrgInviteRow[]> {
    const now = Date.now();
    const rows = await this.db
      .select()
      .from(organizationInvites)
      .where(and(eq(organizationInvites.orgId, orgId), gt(organizationInvites.expiresAt, now)));
    return rows.map(toInvite);
  }

  async createInvite(invite: OrgInviteRow): Promise<void> {
    await this.db.insert(organizationInvites).values(invite);
  }

  async findInviteById(inviteId: string): Promise<OrgInviteRow | null> {
    const rows = await this.db.select().from(organizationInvites).where(eq(organizationInvites.id, inviteId));
    return rows[0] ? toInvite(rows[0]) : null;
  }

  async findInviteByToken(token: string): Promise<OrgInviteRow | null> {
    const rows = await this.db.select().from(organizationInvites).where(eq(organizationInvites.token, token));
    return rows[0] ? toInvite(rows[0]) : null;
  }

  async deleteInvite(inviteId: string): Promise<void> {
    await this.db.delete(organizationInvites).where(eq(organizationInvites.id, inviteId));
  }
}
