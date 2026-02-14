import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Tracks per-tenant backup status for admin dashboard.
 * Updated after each nightly backup run.
 */
export const backupStatus = sqliteTable(
  "backup_status",
  {
    /** Tenant container name (e.g. "tenant_abc") */
    containerId: text("container_id").primaryKey(),
    /** Node that performed the backup */
    nodeId: text("node_id").notNull(),
    /** ISO timestamp of last successful backup */
    lastBackupAt: text("last_backup_at"),
    /** Size of last backup in MB */
    lastBackupSizeMb: real("last_backup_size_mb"),
    /** Remote path of last backup in DO Spaces */
    lastBackupPath: text("last_backup_path"),
    /** Whether the last backup attempt succeeded */
    lastBackupSuccess: integer("last_backup_success", { mode: "boolean" }).notNull().default(false),
    /** Error message if last backup failed */
    lastBackupError: text("last_backup_error"),
    /** Total number of successful backups */
    totalBackups: integer("total_backups").notNull().default(0),
    /** ISO timestamp of record creation */
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    /** ISO timestamp of last update */
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_backup_status_node").on(table.nodeId),
    index("idx_backup_status_last_backup").on(table.lastBackupAt),
  ],
);
