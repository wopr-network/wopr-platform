import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tenantCustomers = sqliteTable(
  "tenant_customers",
  {
    tenant: text("tenant").primaryKey(),
    processorCustomerId: text("processor_customer_id").notNull().unique(),
    processor: text("processor").notNull().default("stripe"),
    tier: text("tier").notNull().default("free"),
    billingHold: integer("billing_hold").notNull().default(0),
    inferenceMode: text("inference_mode").notNull().default("byok"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_tenant_customers_processor").on(table.processorCustomerId)],
);

export const stripeUsageReports = sqliteTable(
  "stripe_usage_reports",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    capability: text("capability").notNull(),
    provider: text("provider").notNull(),
    periodStart: integer("period_start").notNull(),
    periodEnd: integer("period_end").notNull(),
    eventName: text("event_name").notNull(),
    valueCents: integer("value_cents").notNull(),
    reportedAt: integer("reported_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_stripe_usage_unique").on(table.tenant, table.capability, table.provider, table.periodStart),
    index("idx_stripe_usage_tenant").on(table.tenant, table.reportedAt),
  ],
);
