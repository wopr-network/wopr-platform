import { bigint, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

/**
 * Per-tenant capability mode settings — lives in the tenant-keys database.
 * Controls whether a tenant uses "hosted" or "byok" mode for each capability.
 */
export const tenantCapabilitySettings = pgTable(
  "tenant_capability_settings",
  {
    tenantId: text("tenant_id").notNull(),
    capability: text("capability").notNull(),
    /** "hosted" | "byok" */
    mode: text("mode").notNull().default("hosted"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.capability] })],
);
