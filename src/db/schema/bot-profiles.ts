import { sql } from "drizzle-orm";
import { index, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Bot profiles table — stores bot configuration templates.
 * Replaces the YAML-based ProfileStore with database-backed persistence.
 *
 * Each profile defines a bot's container configuration: image, env vars,
 * restart policy, update policy, release channel, and discovery settings.
 */
export const botProfiles = pgTable(
  "bot_profiles",
  {
    /** Bot UUID (matches fleet profile ID) */
    id: text("id").primaryKey(),
    /** Owning tenant ID */
    tenantId: text("tenant_id").notNull(),
    /** Bot display name (1-63 alphanumeric chars, hyphens, underscores) */
    name: text("name").notNull(),
    /** Docker image reference (e.g. "ghcr.io/wopr-network/wopr:latest") */
    image: text("image").notNull(),
    /** Environment variables as JSON object (e.g. {"TOKEN":"abc","DEBUG":"1"}) */
    env: text("env").notNull().default("{}"),
    /** Docker restart policy: "no" | "always" | "on-failure" | "unless-stopped" */
    restartPolicy: text("restart_policy").notNull().default("unless-stopped"),
    /** Update policy: "on-push" | "nightly" | "manual" | "cron:<expression>" */
    updatePolicy: text("update_policy").notNull().default("on-push"),
    /** Release channel: "canary" | "staging" | "stable" | "pinned" */
    releaseChannel: text("release_channel").notNull().default("stable"),
    /** Docker named volume for persistent data (optional) */
    volumeName: text("volume_name"),
    /** P2P discovery configuration as JSON (optional, matches DiscoveryConfig schema) */
    discoveryJson: text("discovery_json"),
    /** Human-readable description */
    description: text("description").notNull().default(""),
    /** ISO timestamp of record creation */
    createdAt: text("created_at").notNull().default(sql`(now())`),
    /** ISO timestamp of last update */
    updatedAt: text("updated_at").notNull().default(sql`(now())`),
  },
  (table) => [
    index("idx_bot_profiles_tenant").on(table.tenantId),
    index("idx_bot_profiles_name").on(table.tenantId, table.name),
    index("idx_bot_profiles_release_channel").on(table.releaseChannel),
  ],
);
