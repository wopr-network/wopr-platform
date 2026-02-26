import { bigint, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const webhookSeenEvents = pgTable(
  "webhook_seen_events",
  {
    eventId: text("event_id").notNull(),
    source: text("source").notNull(),
    seenAt: bigint("seen_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.source] }),
    index("idx_webhook_seen_expires").on(table.seenAt),
  ],
);
