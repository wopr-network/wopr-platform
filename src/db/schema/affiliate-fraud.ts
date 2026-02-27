import { sql } from "drizzle-orm";
import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const affiliateFraudEvents = pgTable(
  "affiliate_fraud_events",
  {
    id: text("id").primaryKey(),
    referralId: text("referral_id").notNull(),
    referrerTenantId: text("referrer_tenant_id").notNull(),
    referredTenantId: text("referred_tenant_id").notNull(),
    verdict: text("verdict").notNull(),
    signals: text("signals").notNull(),
    signalDetails: text("signal_details").notNull(),
    phase: text("phase").notNull(),
    createdAt: text("created_at").notNull().default(sql`(now())`),
  },
  (table) => [
    index("idx_fraud_referrer").on(table.referrerTenantId),
    index("idx_fraud_referred").on(table.referredTenantId),
    index("idx_fraud_verdict").on(table.verdict),
    uniqueIndex("uq_fraud_referral_phase").on(table.referralId, table.phase),
  ],
);
