import { desc, sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull().default(""),
    instanceId: text("instance_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name"),
    type: text("type", { enum: ["nightly", "on-demand", "pre-restore"] })
      .notNull()
      .default("on-demand"),
    s3Key: text("s3_key"),
    sizeMb: real("size_mb").notNull().default(0),
    sizeBytes: integer("size_bytes"),
    nodeId: text("node_id"),
    trigger: text("trigger", { enum: ["manual", "scheduled", "pre_update"] }).notNull(),
    plugins: text("plugins").notNull().default("[]"),
    configHash: text("config_hash").notNull().default(""),
    storagePath: text("storage_path").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    expiresAt: integer("expires_at"),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("idx_snapshots_instance").on(table.instanceId, desc(table.createdAt)),
    index("idx_snapshots_user").on(table.userId),
    index("idx_snapshots_tenant").on(table.tenant),
    index("idx_snapshots_type").on(table.type),
    index("idx_snapshots_expires").on(table.expiresAt),
    check("trigger_check", sql`trigger IN ('manual', 'scheduled', 'pre_update')`),
    check("type_check", sql`type IN ('nightly', 'on-demand', 'pre-restore')`),
  ],
);
