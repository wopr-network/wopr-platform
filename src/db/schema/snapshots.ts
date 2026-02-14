import { desc, sql } from "drizzle-orm";
import { index, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    sizeMb: real("size_mb").notNull().default(0),
    trigger: text("trigger", { enum: ["manual", "scheduled", "pre_update"] }).notNull(),
    plugins: text("plugins").notNull().default("[]"),
    configHash: text("config_hash").notNull().default(""),
    storagePath: text("storage_path").notNull(),
  },
  (table) => [
    index("idx_snapshots_instance").on(table.instanceId, desc(table.createdAt)),
    index("idx_snapshots_user").on(table.userId),
  ],
);
