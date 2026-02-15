import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Nodes table — tracks registered compute nodes in the platform.
 * Each node runs the wopr-node-agent daemon that sends heartbeats and executes commands.
 */
export const nodes = sqliteTable(
  "nodes",
  {
    /** Node ID (e.g. "node-1", "node-2") */
    id: text("id").primaryKey(),
    /** IP address or hostname */
    host: text("host").notNull(),
    /** Node status: active | unhealthy | offline | recovering */
    status: text("status").notNull().default("active"),
    /** Total memory capacity in MB */
    capacityMb: integer("capacity_mb").notNull(),
    /** Used memory in MB (sum of all container allocations) */
    usedMb: integer("used_mb").notNull().default(0),
    /** Version of the node agent daemon */
    agentVersion: text("agent_version"),
    /** Unix epoch seconds of last heartbeat */
    lastHeartbeatAt: integer("last_heartbeat_at"),
    /** Unix epoch seconds when node was registered */
    registeredAt: integer("registered_at").notNull().default(sql`(unixepoch())`),
    /** Unix epoch seconds when node was last updated */
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => [index("idx_nodes_status").on(table.status)],
);
