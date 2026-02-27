import { sql } from "drizzle-orm";
import { index, pgTable, text, unique } from "drizzle-orm/pg-core";

export const pluginConfigs = pgTable(
  "plugin_configs",
  {
    id: text("id").primaryKey(),
    botId: text("bot_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    /** JSON object: { fieldKey: "plaintext-or-encrypted-value", ... } */
    configJson: text("config_json").notNull(),
    /** JSON object: { fieldKey: { iv, authTag, ciphertext }, ... } — only secret fields */
    encryptedFieldsJson: text("encrypted_fields_json"),
    /** Setup session ID that created this config (for rollback) */
    setupSessionId: text("setup_session_id"),
    createdAt: text("created_at").notNull().default(sql`(now()::text)`),
    updatedAt: text("updated_at").notNull().default(sql`(now()::text)`),
  },
  (t) => [
    unique("plugin_configs_bot_plugin_uniq").on(t.botId, t.pluginId),
    index("plugin_configs_bot_id_idx").on(t.botId),
    index("plugin_configs_setup_session_idx").on(t.setupSessionId),
  ],
);
