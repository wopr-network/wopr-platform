import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const gatewayMetrics = sqliteTable(
  "gateway_metrics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    minuteKey: integer("minute_key").notNull(),
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
