import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const tenantAddons = pgTable(
  "tenant_addons",
  {
    tenantId: text("tenant_id").notNull(),
    addonKey: text("addon_key").notNull(),
    enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.addonKey] }),
    index("idx_tenant_addons_tenant").on(table.tenantId),
  ],
);
