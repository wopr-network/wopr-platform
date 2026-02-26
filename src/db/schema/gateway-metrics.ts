import { bigint, index, integer, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

export const gatewayMetrics = pgTable(
  "gateway_metrics",
  {
    id: serial("id").primaryKey(),
    minuteKey: bigint("minute_key", { mode: "number" }).notNull(),
    capability: text("capability").notNull(),
    requests: integer("requests").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    creditFailures: integer("credit_failures").notNull().default(0),
  },
  (table) => [
    uniqueIndex("idx_gateway_metrics_unique").on(table.minuteKey, table.capability),
    index("idx_gateway_metrics_minute").on(table.minuteKey),
  ],
);
