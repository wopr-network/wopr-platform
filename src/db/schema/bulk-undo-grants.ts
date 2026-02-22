import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const bulkUndoGrants = sqliteTable(
  "bulk_undo_grants",
  {
    operationId: text("operation_id").primaryKey(),
    tenantIds: text("tenant_ids").notNull(),
    amountCents: integer("amount_cents").notNull(),
    adminUser: text("admin_user").notNull(),
    createdAt: integer("created_at").notNull(),
    undoDeadline: integer("undo_deadline").notNull(),
    undone: integer("undone").notNull().default(0),
  },
  (table) => [index("idx_bulk_undo_deadline").on(table.undoDeadline)],
);
