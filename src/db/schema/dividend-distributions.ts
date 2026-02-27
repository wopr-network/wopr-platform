import { sql } from "drizzle-orm";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Dividend distribution ledger — one row per tenant per day when a dividend is paid.
 * Written by the nightly dividend cron; read by the dividend API endpoints.
 */
export const dividendDistributions = pgTable(
  "dividend_distributions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    date: text("date").notNull(),
    amountCredits: integer("amount_credits").notNull(),
    poolCredits: integer("pool_credits").notNull(),
    activeUsers: integer("active_users").notNull(),
    createdAt: text("created_at").notNull().default(sql`(now())`),
  },
  (table) => [
    index("idx_dividend_dist_tenant").on(table.tenantId),
    index("idx_dividend_dist_date").on(table.date),
    index("idx_dividend_dist_tenant_date").on(table.tenantId, table.date),
  ],
);
