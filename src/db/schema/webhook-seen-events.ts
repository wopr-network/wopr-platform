import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const webhookSeenEvents = sqliteTable(
  "webhook_seen_events",
  {
    eventId: text("event_id").notNull(),
    source: text("source").notNull(),
    seenAt: integer("seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.source] }),
    index("idx_webhook_seen_expires").on(table.seenAt),
  ],
);
