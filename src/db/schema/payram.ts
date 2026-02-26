import { sql } from "drizzle-orm";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * PayRam payment sessions — tracks the lifecycle of each crypto payment.
 * reference_id is the PayRam-assigned unique identifier.
 */
export const payramCharges = pgTable(
  "payram_charges",
  {
    referenceId: text("reference_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    amountUsdCents: integer("amount_usd_cents").notNull(),
    status: text("status").notNull().default("OPEN"),
    currency: text("currency"),
    filledAmount: text("filled_amount"),
    createdAt: text("created_at").notNull().default(sql`(now())`),
    updatedAt: text("updated_at").notNull().default(sql`(now())`),
    creditedAt: text("credited_at"),
  },
  (table) => [
    index("idx_payram_charges_tenant").on(table.tenantId),
    index("idx_payram_charges_status").on(table.status),
    index("idx_payram_charges_created").on(table.createdAt),
  ],
);
