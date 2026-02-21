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
    /** Node status: active | unhealthy | offline | recovering | draining | provisioning | failed */
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
    /** DigitalOcean droplet ID (null for manually registered nodes) */
    dropletId: text("droplet_id"),
    /** DO region slug (e.g. "nyc1") */
    region: text("region"),
    /** DO size slug (e.g. "s-4vcpu-8gb") */
    size: text("size"),
    /** Monthly cost in USD cents (e.g. 4800 for $48/mo) */
    monthlyCostCents: integer("monthly_cost_cents"),
    /** Provisioning progress stage: null | "creating" | "waiting_active" | "installing_docker" | "pulling_image" | "waiting_agent" | "ready" | "failed" */
    provisionStage: text("provision_stage"),
    /** Error message if provisioning or drain failed */
    lastError: text("last_error"),
    /** Drain state: null (not draining) | "draining" | "drained" */
    drainStatus: text("drain_status"),
    /** Number of tenants migrated during current drain */
    drainMigrated: integer("drain_migrated"),
    /** Total tenants to migrate during current drain */
    drainTotal: integer("drain_total"),
    /** User ID of the self-hosted node owner (null for platform-provisioned DO droplets) */
    ownerUserId: text("owner_user_id"),
    /** Per-node persistent API key hash (sha256 of the secret returned at registration) */
    nodeSecret: text("node_secret"),
    /** Human-friendly label from the registration token */
    label: text("label"),
  },
  (table) => [index("idx_nodes_status").on(table.status), index("idx_nodes_droplet").on(table.dropletId)],
);
