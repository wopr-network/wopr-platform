import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * PayRam payment sessions — tracks the lifecycle of each crypto payment.
 * reference_id is the PayRam-assigned unique identifier.
 */
export const payramCharges = sqliteTable(
  "payram_charges",
  {
    referenceId: text("reference_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    amountUsdCents: integer("amount_usd_cents").notNull(),
    status: text("status").notNull().default("OPEN"),
    currency: text("currency"),
    filledAmount: text("filled_amount"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
    creditedAt: text("credited_at"),
  },
  (table) => [
    index("idx_payram_charges_tenant").on(table.tenantId),
    index("idx_payram_charges_status").on(table.status),
    index("idx_payram_charges_created").on(table.createdAt),
  ],
);
