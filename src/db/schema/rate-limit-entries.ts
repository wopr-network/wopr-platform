import { bigint, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const rateLimitEntries = pgTable(
  "rate_limit_entries",
  {
    key: text("key").notNull(),
    scope: text("scope").notNull(),
    count: integer("count").notNull().default(0),
    windowStart: bigint("window_start", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.scope] }), index("idx_rate_limit_window").on(table.windowStart)],
);
