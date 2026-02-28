import { bigint, index, integer, pgTable, real, text, uniqueIndex } from "drizzle-orm/pg-core";

export const meterEvents = pgTable(
  "meter_events",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    cost: bigint("cost", { mode: "number" }).notNull(),
    charge: bigint("charge", { mode: "number" }).notNull(),
    capability: text("capability").notNull(),
    provider: text("provider").notNull(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    sessionId: text("session_id"),
    duration: integer("duration"),
    usageUnits: real("usage_units"),
    usageUnitType: text("usage_unit_type"),
    tier: text("tier"),
    metadata: text("metadata"),
  },
  (table) => [
    index("idx_meter_tenant").on(table.tenant),
    index("idx_meter_timestamp").on(table.timestamp),
    index("idx_meter_capability").on(table.capability),
    index("idx_meter_session").on(table.sessionId),
    index("idx_meter_tenant_timestamp").on(table.tenant, table.timestamp),
    index("idx_meter_tier").on(table.tier),
  ],
);

export const usageSummaries = pgTable(
  "usage_summaries",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    capability: text("capability").notNull(),
    provider: text("provider").notNull(),
    eventCount: integer("event_count").notNull(),
    totalCost: bigint("total_cost", { mode: "number" }).notNull(),
    totalCharge: bigint("total_charge", { mode: "number" }).notNull(),
    totalDuration: integer("total_duration").notNull().default(0),
    windowStart: bigint("window_start", { mode: "number" }).notNull(),
    windowEnd: bigint("window_end", { mode: "number" }).notNull(),
  },
  (table) => [
    index("idx_summary_tenant").on(table.tenant, table.windowStart),
    index("idx_summary_window").on(table.windowStart, table.windowEnd),
  ],
);

export const billingPeriodSummaries = pgTable(
  "billing_period_summaries",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    capability: text("capability").notNull(),
    provider: text("provider").notNull(),
    eventCount: integer("event_count").notNull(),
    totalCost: bigint("total_cost", { mode: "number" }).notNull(),
    totalCharge: bigint("total_charge", { mode: "number" }).notNull(),
    totalDuration: integer("total_duration").notNull().default(0),
    periodStart: bigint("period_start", { mode: "number" }).notNull(),
    periodEnd: bigint("period_end", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_billing_period_unique").on(table.tenant, table.capability, table.provider, table.periodStart),
    index("idx_billing_period_tenant").on(table.tenant, table.periodStart),
    index("idx_billing_period_window").on(table.periodStart, table.periodEnd),
  ],
);
