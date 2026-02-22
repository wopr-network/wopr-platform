import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const providerHealthOverrides = sqliteTable("provider_health_overrides", {
  adapter: text("adapter").primaryKey(),
  healthy: integer("healthy").notNull().default(1),
  markedAt: integer("marked_at").notNull(),
});
