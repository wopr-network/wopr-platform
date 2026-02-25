import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pluginMarketplaceContent = sqliteTable("plugin_marketplace_content", {
  pluginId: text("plugin_id").primaryKey(),
  version: text("version").notNull(),
  markdown: text("markdown").notNull(),
  source: text("source").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
