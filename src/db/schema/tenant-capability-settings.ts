import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Per-tenant capability mode settings — lives in the tenant-keys database.
 * Controls whether a tenant uses "hosted" or "byok" mode for each capability.
 */
export const tenantCapabilitySettings = sqliteTable(
  "tenant_capability_settings",
  {
    tenantId: text("tenant_id").notNull(),
    capability: text("capability").notNull(),
    /** "hosted" | "byok" */
    mode: text("mode").notNull().default("hosted"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.capability] })],
);
