import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * GPU nodes table — tracks shared GPU compute infrastructure.
 * Unlike regular nodes, GPU nodes are not tenant-bound and not part of the bot node fleet.
 * They provide GPU capabilities (e.g. local Whisper/Piper) to the platform.
 */
export const gpuNodes = pgTable(
  "gpu_nodes",
  {
    /** Unique GPU node identifier */
    id: text("id").primaryKey(),
    /** DigitalOcean droplet ID (null if not yet created) */
    dropletId: text("droplet_id"),
    /** IP address or hostname */
    host: text("host"),
    /** DO region slug (e.g. "nyc1") */
    region: text("region").notNull(),
    /** DO size slug (e.g. "g-2vcpu-8gb") */
    size: text("size").notNull(),
    /** Node status: provisioning | active | unhealthy | offline | failed */
    status: text("status").notNull().default("provisioning"),
    /** Provisioning stage: creating | waiting_active | installing_deps | pulling_models | ready | failed */
    provisionStage: text("provision_stage").notNull().default("creating"),
    /** JSON object describing health of GPU services (null until first health check) */
    serviceHealth: text("service_health"),
    /** Monthly cost in USD cents (e.g. 67200 for $672/mo) */
    monthlyCostCents: integer("monthly_cost_cents"),
    /** Unix epoch seconds of last successful health check */
    lastHealthAt: bigint("last_health_at", { mode: "number" }),
    /** Error message from last failed operation */
    lastError: text("last_error"),
    /** Unix epoch seconds when node was created */
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()))::bigint`),
    /** Unix epoch seconds when node was last updated */
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()))::bigint`),
  },
  (table) => [index("idx_gpu_nodes_status").on(table.status), index("idx_gpu_nodes_region").on(table.region)],
);
