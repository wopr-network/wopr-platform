import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"), // "owner" | "admin" | "member"
    joinedAt: bigint("joined_at", { mode: "number" })
      .notNull()
      .default(sql`(extract(epoch from now()) * 1000)::bigint`),
  },
  (table) => [
    index("idx_org_members_org_id").on(table.orgId),
    index("idx_org_members_user_id").on(table.userId),
    uniqueIndex("org_members_org_user_unique").on(table.orgId, table.userId),
  ],
);

export const organizationInvites = pgTable(
  "organization_invites",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"), // "admin" | "member"
    invitedBy: text("invited_by").notNull(),
    token: text("token").notNull().unique(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .default(sql`(extract(epoch from now()) * 1000)::bigint`),
  },
  (table) => [index("idx_org_invites_org_id").on(table.orgId), index("idx_org_invites_token").on(table.token)],
);
