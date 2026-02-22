import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const webhookSeenEvents = sqliteTable(
  "webhook_seen_events",
  {
    eventId: text("event_id").primaryKey(),
    source: text("source").notNull(),
    seenAt: integer("seen_at").notNull(),
  },
  (table) => [index("idx_webhook_seen_expires").on(table.seenAt)],
);
