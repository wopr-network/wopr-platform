import { bigint, pgTable, text } from "drizzle-orm/pg-core";

export const pluginMarketplaceContent = pgTable("plugin_marketplace_content", {
  pluginId: text("plugin_id").primaryKey(),
  version: text("version").notNull(),
  markdown: text("markdown").notNull(),
  source: text("source").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
