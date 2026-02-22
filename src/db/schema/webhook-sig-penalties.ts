import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const webhookSigPenalties = sqliteTable(
  "webhook_sig_penalties",
  {
    ip: text("ip").notNull(),
    source: text("source").notNull(),
    failures: integer("failures").notNull().default(0),
    blockedUntil: integer("blocked_until").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ip, table.source] }),
    index("idx_sig_penalties_blocked").on(table.blockedUntil),
  ],
);
