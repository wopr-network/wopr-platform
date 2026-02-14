import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const meterEvents = sqliteTable(
  "meter_events",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    cost: real("cost").notNull(),
    charge: real("charge").notNull(),
    capability: text("capability").notNull(),
    provider: text("provider").notNull(),
    timestamp: integer("timestamp").notNull(),
    sessionId: text("session_id"),
    duration: integer("duration"),
  },
  (table) => [
    index("idx_meter_tenant").on(table.tenant),
    index("idx_meter_timestamp").on(table.timestamp),
    index("idx_meter_capability").on(table.capability),
    index("idx_meter_session").on(table.sessionId),
    index("idx_meter_tenant_timestamp").on(table.tenant, table.timestamp),
  ],
);

export const usageSummaries = sqliteTable(
  "usage_summaries",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    capability: text("capability").notNull(),
    provider: text("provider").notNull(),
    eventCount: integer("event_count").notNull(),
    totalCost: real("total_cost").notNull(),
    totalCharge: real("total_charge").notNull(),
    totalDuration: integer("total_duration").notNull().default(0),
    windowStart: integer("window_start").notNull(),
    windowEnd: integer("window_end").notNull(),
  },
  (table) => [
    index("idx_summary_tenant").on(table.tenant, table.windowStart),
    index("idx_summary_window").on(table.windowStart, table.windowEnd),
  ],
);

export const billingPeriodSummaries = sqliteTable(
  "billing_period_summaries",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    capability: text("capability").notNull(),
    provider: text("provider").notNull(),
    eventCount: integer("event_count").notNull(),
    totalCost: real("total_cost").notNull(),
    totalCharge: real("total_charge").notNull(),
    totalDuration: integer("total_duration").notNull().default(0),
    periodStart: integer("period_start").notNull(),
    periodEnd: integer("period_end").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_billing_period_unique").on(table.tenant, table.capability, table.provider, table.periodStart),
    index("idx_billing_period_tenant").on(table.tenant, table.periodStart),
    index("idx_billing_period_window").on(table.periodStart, table.periodEnd),
  ],
);
