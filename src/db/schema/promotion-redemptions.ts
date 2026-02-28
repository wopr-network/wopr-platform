import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { couponCodes } from "./coupon-codes.js";
import { promotions } from "./promotions.js";

export const promotionRedemptions = pgTable(
  "promotion_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promotionId: uuid("promotion_id")
      .notNull()
      .references(() => promotions.id),
    tenantId: text("tenant_id").notNull(),
    couponCodeId: uuid("coupon_code_id").references(() => couponCodes.id),
    creditsGranted: integer("credits_granted").notNull(),
    creditTransactionId: text("credit_transaction_id").notNull(),
    purchaseAmountCredits: integer("purchase_amount_credits"),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("promotion_redemptions_promotion_idx").on(t.promotionId),
    index("promotion_redemptions_tenant_idx").on(t.tenantId),
  ],
);
