import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Internal admin notes per tenant — visible only to platform operators.
 * Not user-facing. Supports pinning important notes to the top.
 */
export const adminNotes = pgTable(
  "admin_notes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    authorId: text("author_id").notNull(),
    content: text("content").notNull(),
    isPinned: integer("is_pinned").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()))::bigint`),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()))::bigint`),
  },
  (table) => [
    index("idx_admin_notes_tenant").on(table.tenantId, table.createdAt),
    index("idx_admin_notes_author").on(table.authorId),
    index("idx_admin_notes_pinned").on(table.tenantId, table.isPinned),
  ],
);
