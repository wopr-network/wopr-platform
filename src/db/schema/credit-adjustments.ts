import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Credit adjustments — audit log of all credit grants, refunds, and corrections.
 * The current balance is computed as SUM(amount_cents) for a tenant.
 */
export const creditAdjustments = sqliteTable(
  "credit_adjustments",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    type: text("type").notNull(),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    adminUser: text("admin_user").notNull(),
    referenceIds: text("reference_ids"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_credit_adjustments_tenant").on(table.tenant),
    index("idx_credit_adjustments_type").on(table.type),
    index("idx_credit_adjustments_created").on(table.createdAt),
  ],
);
