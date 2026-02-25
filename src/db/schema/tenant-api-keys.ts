import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Tenant BYOK API keys — lives in the tenant-keys database.
 * Keys are encrypted at rest with AES-256-GCM.
 * One key per provider per tenant (enforced by unique index).
 */
export const tenantApiKeys = sqliteTable(
  "tenant_api_keys",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    provider: text("provider").notNull(),
    /** Human-readable label. Never contains the key itself. */
    label: text("label").notNull().default(""),
    /** AES-256-GCM encrypted key payload (JSON-serialized EncryptedPayload). */
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
