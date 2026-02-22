import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const rateLimitEntries = sqliteTable(
  "rate_limit_entries",
  {
    key: text("key").notNull(),
    scope: text("scope").notNull(),
    count: integer("count").notNull().default(0),
    windowStart: integer("window_start").notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.scope] }), index("idx_rate_limit_window").on(table.windowStart)],
);
