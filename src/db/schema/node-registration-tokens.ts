import { sql } from "drizzle-orm";
import { bigint, boolean, index, pgTable, text } from "drizzle-orm/pg-core";

/**
 * One-time registration tokens for self-hosted node agents.
 * Generated from the UI, expire after 15 minutes, single-use.
 */
export const nodeRegistrationTokens = pgTable(
  "node_registration_tokens",
  {
    /** Random UUID token value (also the primary key) */
    id: text("id").primaryKey(),
    /** User ID who created this token */
    userId: text("user_id").notNull(),
    /** Optional human label (e.g., "Living room Mac Mini") */
    label: text("label"),
    /** Unix epoch seconds when token was created */
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now())::bigint)`),
    /** Unix epoch seconds when token expires (createdAt + 900) */
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    /** Whether this token has been consumed */
    used: boolean("used").notNull().default(false),
    /** Node ID assigned when token was consumed (null if unused) */
    nodeId: text("node_id"),
    /** Unix epoch seconds when token was consumed */
    usedAt: bigint("used_at", { mode: "number" }),
  },
  (table) => [index("idx_reg_tokens_user").on(table.userId), index("idx_reg_tokens_expires").on(table.expiresAt)],
);
