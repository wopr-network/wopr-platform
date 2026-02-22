import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const circuitBreakerStates = sqliteTable(
  "circuit_breaker_states",
  {
    instanceId: text("instance_id").primaryKey(),
    count: integer("count").notNull().default(0),
    windowStart: integer("window_start").notNull(),
    trippedAt: integer("tripped_at"),
  },
  (table) => [index("idx_circuit_window").on(table.windowStart)],
);
