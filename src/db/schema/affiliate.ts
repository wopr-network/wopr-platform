import { sql } from "drizzle-orm";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Affiliate codes — one per tenant, generated lazily on first request.
 * Code is a short 6-char alphanumeric string used in referral links.
 */
export const affiliateCodes = pgTable("affiliate_codes", {
  tenantId: text("tenant_id").primaryKey(),
  code: text("code").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`(now())`),
});

/**
 * Affiliate referrals — tracks who referred whom and conversion status.
 * referred_tenant_id is UNIQUE to enforce first-referrer-wins.
 */
export const affiliateReferrals = pgTable(
  "affiliate_referrals",
  {
    id: text("id").primaryKey(),
    referrerTenantId: text("referrer_tenant_id").notNull(),
    referredTenantId: text("referred_tenant_id").notNull().unique(),
    code: text("code").notNull(),
    signedUpAt: text("signed_up_at").notNull().default(sql`(now())`),
    firstPurchaseAt: text("first_purchase_at"),
    matchAmountCents: integer("match_amount_cents"),
    matchedAt: text("matched_at"),
  },
  (table) => [
    index("idx_affiliate_ref_referrer").on(table.referrerTenantId),
    index("idx_affiliate_ref_code").on(table.code),
  ],
);
