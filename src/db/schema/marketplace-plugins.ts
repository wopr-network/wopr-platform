import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const marketplacePlugins = sqliteTable("marketplace_plugins", {
  pluginId: text("plugin_id").primaryKey(),
  npmPackage: text("npm_package").notNull(),
  version: text("version").notNull(),
  enabled: integer("enabled").notNull().default(0),
  featured: integer("featured").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(999),
  category: text("category"),
  discoveredAt: integer("discovered_at").notNull(),
  enabledAt: integer("enabled_at"),
  enabledBy: text("enabled_by"),
  notes: text("notes"),
});
