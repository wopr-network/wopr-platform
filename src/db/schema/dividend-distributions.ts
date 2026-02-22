import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Dividend distribution ledger — one row per tenant per day when a dividend is paid.
 * Written by the nightly dividend cron; read by the dividend API endpoints.
 */
export const dividendDistributions = sqliteTable(
  "dividend_distributions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    date: text("date").notNull(),
    amountCents: integer("amount_cents").notNull(),
    poolCents: integer("pool_cents").notNull(),
    activeUsers: integer("active_users").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_dividend_dist_tenant").on(table.tenantId),
    index("idx_dividend_dist_date").on(table.date),
    index("idx_dividend_dist_tenant_date").on(table.tenantId, table.date),
  ],
);
