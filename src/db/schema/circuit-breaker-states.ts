import { bigint, index, integer, pgTable, text } from "drizzle-orm/pg-core";

export const circuitBreakerStates = pgTable(
  "circuit_breaker_states",
  {
    instanceId: text("instance_id").primaryKey(),
    count: integer("count").notNull().default(0),
    windowStart: bigint("window_start", { mode: "number" }).notNull(),
    trippedAt: bigint("tripped_at", { mode: "number" }),
  },
  (table) => [index("idx_circuit_window").on(table.windowStart)],
);
