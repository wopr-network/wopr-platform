import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * SQLite-compatible bot_profiles schema for use by scripts/migrate-profiles-to-db.ts.
 *
 * The main application uses the PostgreSQL version from @wopr-network/platform-core.
 * This local definition exists so the migration script can operate against the old
 * SQLite database (better-sqlite3) that it reads during the one-time data migration.
 */
export const botProfiles = sqliteTable(
  "bot_profiles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    image: text("image").notNull(),
    env: text("env").notNull().default("{}"),
    restartPolicy: text("restart_policy").notNull().default("unless-stopped"),
    updatePolicy: text("update_policy").notNull().default("on-push"),
    releaseChannel: text("release_channel").notNull().default("stable"),
    volumeName: text("volume_name"),
    discoveryJson: text("discovery_json"),
    description: text("description").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_bot_profiles_tenant").on(table.tenantId),
    index("idx_bot_profiles_name").on(table.tenantId, table.name),
    index("idx_bot_profiles_release_channel").on(table.releaseChannel),
  ],
);
