import { bigint, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const tenantCustomers = pgTable(
  "tenant_customers",
  {
    tenant: text("tenant").primaryKey(),
    processorCustomerId: text("processor_customer_id").notNull().unique(),
    processor: text("processor").notNull().default("stripe"),
    tier: text("tier").notNull().default("free"),
    billingHold: integer("billing_hold").notNull().default(0),
    inferenceMode: text("inference_mode").notNull().default("byok"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_tenant_customers_processor").on(table.processorCustomerId)],
);

export const stripeUsageReports = pgTable(
  "stripe_usage_reports",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    capability: text("capability").notNull(),
    provider: text("provider").notNull(),
    periodStart: bigint("period_start", { mode: "number" }).notNull(),
    periodEnd: bigint("period_end", { mode: "number" }).notNull(),
    eventName: text("event_name").notNull(),
    valueCents: integer("value_cents").notNull(),
    reportedAt: bigint("reported_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_stripe_usage_unique").on(table.tenant, table.capability, table.provider, table.periodStart),
    index("idx_stripe_usage_tenant").on(table.tenant, table.reportedAt),
  ],
);
