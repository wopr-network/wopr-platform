import { sql } from "drizzle-orm";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Records every auto-topup attempt — both successes and failures.
 * Used by admin analytics to track auto-topup revenue and failure rates.
 */
export const creditAutoTopup = pgTable(
  "credit_auto_topup",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    amountCredits: integer("amount_credits").notNull(),
    status: text("status").notNull(), // "success" | "failed"
    failureReason: text("failure_reason"),
    /** Stripe payment intent or charge ID, if applicable */
    paymentReference: text("payment_reference"),
    createdAt: text("created_at").notNull().default(sql`(now())`),
  },
  (table) => [
    index("idx_auto_topup_tenant").on(table.tenantId),
    index("idx_auto_topup_status").on(table.status),
    index("idx_auto_topup_created").on(table.createdAt),
    index("idx_auto_topup_tenant_created").on(table.tenantId, table.createdAt),
  ],
);
