import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const platformApiKeys = pgTable(
  "platform_api_keys",
  {
    id: text("id").primaryKey(),
    /** SHA-256 hex digest of the raw API key. Raw key is NEVER stored. */
    keyHash: text("key_hash").notNull(),
    /** The user this key authenticates as. */
    userId: text("user_id").notNull(),
    /** JSON-serialized string[] of roles (e.g. '["admin","user"]'). */
    roles: text("roles").notNull(),
    /** Optional human-readable label. */
    label: text("label").notNull().default(""),
    /** Unix epoch ms. Null = never expires. */
    expiresAt: bigint("expires_at", { mode: "number" }),
    /** Unix epoch ms. Null = not revoked. */
    revokedAt: bigint("revoked_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_platform_api_keys_hash").on(table.keyHash),
    index("idx_platform_api_keys_user").on(table.userId),
  ],
);
