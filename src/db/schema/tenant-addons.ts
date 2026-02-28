import { sql } from "drizzle-orm";
import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const tenantAddons = pgTable(
  "tenant_addons",
  {
    tenantId: text("tenant_id").notNull(),
    addonKey: text("addon_key").notNull(),
    enabledAt: text("enabled_at").notNull().default(sql`(now())`),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.addonKey] }),
    index("idx_tenant_addons_tenant").on(table.tenantId),
  ],
);
