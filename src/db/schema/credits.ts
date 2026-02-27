import { sql } from "drizzle-orm";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Credit transaction ledger — every credit/debit is an immutable row.
 * Positive amountCredits = credit (money in), negative = debit (money out).
 */
export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    amountCredits: integer("amount_credits").notNull(),
    balanceAfterCredits: integer("balance_after_credits").notNull(),
    type: text("type").notNull(), // signup_grant | purchase | bounty | referral | promo | community_dividend | bot_runtime | adapter_usage | addon | refund | correction
    description: text("description"),
    referenceId: text("reference_id").unique(),
    fundingSource: text("funding_source"), // "stripe" | "payram" | null (null = legacy/signup)
    attributedUserId: text("attributed_user_id"), // nullable — null for system/bot charges
    createdAt: text("created_at").notNull().default(sql`(now())`),
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
export const creditBalances = pgTable("credit_balances", {
  tenantId: text("tenant_id").primaryKey(),
  balanceCredits: integer("balance_credits").notNull().default(0),
  lastUpdated: text("last_updated").notNull().default(sql`(now())`),
});
