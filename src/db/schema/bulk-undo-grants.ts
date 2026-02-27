import { bigint, index, integer, pgTable, text } from "drizzle-orm/pg-core";

export const bulkUndoGrants = pgTable(
  "bulk_undo_grants",
  {
    operationId: text("operation_id").primaryKey(),
    tenantIds: text("tenant_ids").notNull(),
    amountCredits: integer("amount_credits").notNull(),
    adminUser: text("admin_user").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    undoDeadline: bigint("undo_deadline", { mode: "number" }).notNull(),
    undone: integer("undone").notNull().default(0),
  },
  (table) => [index("idx_bulk_undo_deadline").on(table.undoDeadline)],
);
