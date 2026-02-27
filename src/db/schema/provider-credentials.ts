import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Provider credentials table — stores encrypted platform-level API keys
 * for upstream AI providers used in hosted/gateway mode.
 *
 * Keys are encrypted at rest with AES-256-GCM. Multiple keys per provider
 * are supported for rotation and load distribution.
 */
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: text("id").primaryKey(),
    /** Provider identifier (e.g. "anthropic", "openai", "openrouter") */
    provider: text("provider").notNull(),
    /** Human-readable label (e.g. "Anthropic Production") */
    keyName: text("key_name").notNull(),
    /** AES-256-GCM encrypted API key (JSON-serialized EncryptedPayload) */
    encryptedValue: text("encrypted_value").notNull(),
    /** Auth mechanism: "header", "bearer", "basic" */
    authType: text("auth_type").notNull(),
    /** HTTP header name for injection (e.g. "x-api-key", "Authorization") */
    authHeader: text("auth_header"),
    /** Whether this credential is active and eligible for use */
    isActive: boolean("is_active").notNull().default(true),
    /** ISO timestamp of last successful validation */
    lastValidated: text("last_validated"),
    /** ISO timestamp of record creation */
    createdAt: text("created_at").notNull().default(sql`(now())`),
    /** ISO timestamp of last key rotation */
    rotatedAt: text("rotated_at"),
    /** Admin user ID who created/last modified this credential */
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    index("idx_provider_creds_provider").on(table.provider),
    index("idx_provider_creds_active").on(table.provider, table.isActive),
    index("idx_provider_creds_created_by").on(table.createdBy),
  ],
);
