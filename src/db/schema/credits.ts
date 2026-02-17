import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Credit transaction ledger — every credit/debit is an immutable row.
 * Positive amountCents = credit (money in), negative = debit (money out).
 */
export const creditTransactions = sqliteTable(
  "credit_transactions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    balanceAfterCents: integer("balance_after_cents").notNull(),
    type: text("type").notNull(), // signup_grant | purchase | bounty | referral | promo | bot_runtime | adapter_usage | addon | refund | correction
    description: text("description"),
    referenceId: text("reference_id").unique(),
    fundingSource: text("funding_source"), // "stripe" | "payram" | null (null = legacy/signup)
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_credit_tx_tenant").on(table.tenantId),
    index("idx_credit_tx_type").on(table.type),
    index("idx_credit_tx_ref").on(table.referenceId),
    index("idx_credit_tx_created").on(table.createdAt),
    index("idx_credit_tx_tenant_created").on(table.tenantId, table.createdAt),
  ],
);

/**
 * Denormalized credit balance per tenant — updated atomically alongside
 * every credit_transactions insert via a Drizzle transaction.
 */
export const creditBalances = sqliteTable("credit_balances", {
  tenantId: text("tenant_id").primaryKey(),
  balanceCents: integer("balance_cents").notNull().default(0),
  lastUpdated: text("last_updated").notNull().default(sql`(datetime('now'))`),
});
