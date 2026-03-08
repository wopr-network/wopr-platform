import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

export const gpuAllocations = pgTable(
  "gpu_allocations",
  {
    id: text("id").primaryKey(),
    gpuNodeId: text("gpu_node_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    botInstanceId: text("bot_instance_id"),
    priority: text("priority").notNull().default("normal"),
    createdAt: bigint("created_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()))::bigint`),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()))::bigint`),
  },
  (table) => [
    index("idx_gpu_allocations_gpu_node_id").on(table.gpuNodeId),
    index("idx_gpu_allocations_tenant_id").on(table.tenantId),
  ],
);
