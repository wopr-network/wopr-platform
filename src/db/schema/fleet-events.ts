import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const fleetEvents = sqliteTable("fleet_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventType: text("event_type").notNull(),
  fired: integer("fired").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  clearedAt: integer("cleared_at"),
});
