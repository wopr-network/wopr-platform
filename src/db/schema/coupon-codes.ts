import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { promotions } from "./promotions.js";

export const couponCodes = pgTable(
  "coupon_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promotionId: uuid("promotion_id")
      .notNull()
      .references(() => promotions.id),
    code: text("code").notNull().unique(),
    assignedTenantId: text("assigned_tenant_id"),
    assignedEmail: text("assigned_email"),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    redeemedByTenantId: text("redeemed_by_tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("coupon_codes_promotion_idx").on(t.promotionId),
    index("coupon_codes_assigned_tenant_idx").on(t.assignedTenantId),
  ],
);
