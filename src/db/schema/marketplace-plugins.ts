import { bigint, index, integer, pgTable, text } from "drizzle-orm/pg-core";

export const marketplacePlugins = pgTable(
  "marketplace_plugins",
  {
    pluginId: text("plugin_id").primaryKey(),
    npmPackage: text("npm_package").notNull(),
    version: text("version").notNull(),
    enabled: integer("enabled").notNull().default(0),
    featured: integer("featured").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(999),
    category: text("category"),
    discoveredAt: bigint("discovered_at", { mode: "number" }).notNull(),
    enabledAt: bigint("enabled_at", { mode: "number" }),
    enabledBy: text("enabled_by"),
    notes: text("notes"),
  },
  (t) => [index("marketplace_plugins_enabled_idx").on(t.enabled)],
);
