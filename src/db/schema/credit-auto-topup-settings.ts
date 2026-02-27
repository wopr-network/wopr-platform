import { sql } from "drizzle-orm";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Per-tenant auto-topup configuration.
 * Two independent modes: usage-based (after spend) and schedule-based (cron).
 */
export const creditAutoTopupSettings = pgTable(
  "credit_auto_topup_settings",
  {
    tenantId: text("tenant_id").primaryKey(),
    // Usage-based trigger
    usageEnabled: integer("usage_enabled").notNull().default(0),
    usageThresholdCredits: integer("usage_threshold_credits").notNull().default(100),
    usageTopupCredits: integer("usage_topup_credits").notNull().default(500),
    usageConsecutiveFailures: integer("usage_consecutive_failures").notNull().default(0),
    usageChargeInFlight: integer("usage_charge_in_flight").notNull().default(0),
    // Schedule-based trigger
    scheduleEnabled: integer("schedule_enabled").notNull().default(0),
    scheduleAmountCredits: integer("schedule_amount_credits").notNull().default(500),
    scheduleIntervalHours: integer("schedule_interval_hours").notNull().default(168),
    scheduleNextAt: text("schedule_next_at"),
    scheduleConsecutiveFailures: integer("schedule_consecutive_failures").notNull().default(0),
    // Metadata
    createdAt: text("created_at").notNull().default(sql`(now())`),
    updatedAt: text("updated_at").notNull().default(sql`(now())`),
  },
  (table) => [
    index("idx_auto_topup_settings_usage").on(table.usageEnabled),
    index("idx_auto_topup_settings_schedule").on(table.scheduleEnabled, table.scheduleNextAt),
  ],
);
