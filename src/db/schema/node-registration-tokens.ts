import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One-time registration tokens for self-hosted node agents.
 * Generated from the UI, expire after 15 minutes, single-use.
 */
export const nodeRegistrationTokens = sqliteTable(
  "node_registration_tokens",
  {
    /** Random UUID token value (also the primary key) */
    id: text("id").primaryKey(),
    /** User ID who created this token */
    userId: text("user_id").notNull(),
    /** Optional human label (e.g., "Living room Mac Mini") */
    label: text("label"),
    /** Unix epoch seconds when token was created */
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    /** Unix epoch seconds when token expires (createdAt + 900) */
    expiresAt: integer("expires_at").notNull(),
    /** Whether this token has been consumed */
    used: integer("used", { mode: "boolean" }).notNull().default(false),
    /** Node ID assigned when token was consumed (null if unused) */
    nodeId: text("node_id"),
    /** Unix epoch seconds when token was consumed */
    usedAt: integer("used_at"),
  },
  (table) => [index("idx_reg_tokens_user").on(table.userId), index("idx_reg_tokens_expires").on(table.expiresAt)],
);
