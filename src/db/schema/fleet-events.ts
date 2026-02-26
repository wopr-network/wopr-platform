import { bigint, integer, pgTable, serial, text } from "drizzle-orm/pg-core";

export const fleetEvents = pgTable("fleet_events", {
  id: serial("id").primaryKey(),
  eventType: text("event_type").notNull(),
  fired: integer("fired").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  clearedAt: bigint("cleared_at", { mode: "number" }),
});
