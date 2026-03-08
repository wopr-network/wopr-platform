import { sql } from "drizzle-orm";
import { bigint, integer, pgTable, text } from "drizzle-orm/pg-core";

export const gpuConfigurations = pgTable("gpu_configurations", {
  gpuNodeId: text("gpu_node_id").primaryKey(),
  memoryLimitMib: integer("memory_limit_mib"),
  modelAssignments: text("model_assignments"),
  maxConcurrency: integer("max_concurrency").notNull().default(1),
  notes: text("notes"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(sql`(extract(epoch from now()))::bigint`),
});
