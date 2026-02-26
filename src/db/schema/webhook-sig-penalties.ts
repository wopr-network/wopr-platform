import { bigint, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const webhookSigPenalties = pgTable(
  "webhook_sig_penalties",
  {
    ip: text("ip").notNull(),
    source: text("source").notNull(),
    failures: integer("failures").notNull().default(0),
    blockedUntil: bigint("blocked_until", { mode: "number" }).notNull().default(0),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ip, table.source] }),
    index("idx_sig_penalties_blocked").on(table.blockedUntil),
  ],
);
