import { bigint, integer, pgTable, text } from "drizzle-orm/pg-core";

export const providerHealthOverrides = pgTable("provider_health_overrides", {
  adapter: text("adapter").primaryKey(),
  healthy: integer("healthy").notNull().default(1),
  markedAt: bigint("marked_at", { mode: "number" }).notNull(),
});
