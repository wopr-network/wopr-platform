import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Bot instances table — tracks billing lifecycle for each bot.
 *
 * Billing states: created -> active -> suspended -> destroyed
 * Reactivation: suspended -> active (when credits purchased)
 */
export const botInstances = sqliteTable(
  "bot_instances",
  {
    /** Bot UUID (matches fleet profile ID) */
    id: text("id").primaryKey(),
    /** Owning tenant */
    tenantId: text("tenant_id").notNull(),
    /** Bot display name */
    name: text("name").notNull(),
    /** Node where this bot is deployed (for recovery tracking) */
    nodeId: text("node_id"),
    /**
     * Billing lifecycle state:
     * - 'active': running, consuming credits daily
     * - 'suspended': stopped, data preserved, no credit consumption
     * - 'destroyed': container + data deleted
     */
    billingState: text("billing_state").notNull().default("active"),
    /** ISO timestamp when bot was suspended; NULL when active */
    suspendedAt: text("suspended_at"),
    /** ISO timestamp for auto-destruction (suspendedAt + 30 days); NULL when active */
    destroyAfter: text("destroy_after"),
    /** Resource tier: standard | pro | power | beast */
    resourceTier: text("resource_tier").notNull().default("standard"),
    /** ISO timestamp of record creation */
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    /** ISO timestamp of last update */
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_bot_instances_tenant").on(table.tenantId),
    index("idx_bot_instances_billing_state").on(table.billingState),
    index("idx_bot_instances_destroy_after").on(table.destroyAfter),
    index("idx_bot_instances_node").on(table.nodeId),
  ],
);
