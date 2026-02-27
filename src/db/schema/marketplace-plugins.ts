import { bigint, boolean, index, integer, pgTable, text } from "drizzle-orm/pg-core";

export const marketplacePlugins = pgTable(
  "marketplace_plugins",
  {
    pluginId: text("plugin_id").primaryKey(),
    npmPackage: text("npm_package").notNull(),
    version: text("version").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    featured: boolean("featured").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(999),
    category: text("category"),
    discoveredAt: bigint("discovered_at", { mode: "number" }).notNull(),
    enabledAt: bigint("enabled_at", { mode: "number" }),
    enabledBy: text("enabled_by"),
    notes: text("notes"),
    installedAt: bigint("installed_at", { mode: "number" }),
    installError: text("install_error"),
  },
  (t) => [index("marketplace_plugins_enabled_idx").on(t.enabled)],
);
