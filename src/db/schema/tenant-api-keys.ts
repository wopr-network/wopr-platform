import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tenantApiKeys = sqliteTable(
  "tenant_api_keys",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    provider: text("provider").notNull(),
    label: text("label").notNull().default(""),
    encryptedKey: text("encrypted_key").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_tenant_keys_tenant_provider").on(table.tenantId, table.provider),
    index("idx_tenant_keys_tenant").on(table.tenantId),
    index("idx_tenant_keys_provider").on(table.provider),
  ],
);
