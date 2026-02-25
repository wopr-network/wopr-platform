import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

export const organizationMembers = sqliteTable(
  "organization_members",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"), // "owner" | "admin" | "member"
    joinedAt: integer("joined_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("idx_org_members_org_id").on(table.orgId),
    index("idx_org_members_user_id").on(table.userId),
    uniqueIndex("org_members_org_user_unique").on(table.orgId, table.userId),
  ],
);

export const organizationInvites = sqliteTable(
  "organization_invites",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"), // "admin" | "member"
    invitedBy: text("invited_by").notNull(),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index("idx_org_invites_org_id").on(table.orgId), index("idx_org_invites_token").on(table.token)],
);
