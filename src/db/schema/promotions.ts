import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const promotionTypeEnum = pgEnum("promotion_type", [
  "bonus_on_purchase",
  "coupon_fixed",
  "coupon_unique",
  "batch_grant",
]);

export const promotionStatusEnum = pgEnum("promotion_status", [
  "draft",
  "scheduled",
  "active",
  "paused",
  "expired",
  "cancelled",
]);

export const promotionValueTypeEnum = pgEnum("promotion_value_type", ["flat_credits", "percent_of_purchase"]);

export const promotionUserSegmentEnum = pgEnum("promotion_user_segment", [
  "all",
  "new_users",
  "existing_users",
  "tenant_list",
]);

export const promotions = pgTable(
  "promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    type: promotionTypeEnum("type").notNull(),
    status: promotionStatusEnum("status").notNull().default("draft"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    valueType: promotionValueTypeEnum("value_type").notNull(),
    valueAmount: integer("value_amount").notNull(),
    maxValueCredits: integer("max_value_credits"),
    firstPurchaseOnly: boolean("first_purchase_only").notNull().default(false),
    minPurchaseCredits: integer("min_purchase_credits"),
    userSegment: promotionUserSegmentEnum("user_segment").notNull().default("all"),
    eligibleTenantIds: text("eligible_tenant_ids").array(),
    totalUseLimit: integer("total_use_limit"),
    perUserLimit: integer("per_user_limit").notNull().default(1),
    budgetCredits: integer("budget_credits"),
    totalUses: integer("total_uses").notNull().default(0),
    totalCreditsGranted: integer("total_credits_granted").notNull().default(0),
    couponCode: text("coupon_code").unique(),
    couponBatchId: uuid("coupon_batch_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
  },
  (t) => [index("promotions_status_idx").on(t.status), index("promotions_coupon_code_idx").on(t.couponCode)],
);
