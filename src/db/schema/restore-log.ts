import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

export const restoreLog = pgTable(
  "restore_log",
  {
    id: text("id").primaryKey(),
    /** Tenant identifier (e.g. "tenant_abc") */
    tenant: text("tenant").notNull(),
    /** S3 key of the snapshot that was restored */
    snapshotKey: text("snapshot_key").notNull(),
    /** S3 key of the pre-restore safety snapshot */
    preRestoreKey: text("pre_restore_key"),
    /** Unix epoch seconds when restore completed */
    restoredAt: bigint("restored_at", { mode: "number" }).notNull(),
    /** User ID of the admin/tenant who triggered the restore */
    restoredBy: text("restored_by").notNull(),
    /** Optional reason for the restore */
    reason: text("reason"),
  },
  (table) => [
    index("idx_restore_log_tenant").on(table.tenant, table.restoredAt),
    index("idx_restore_log_restored_by").on(table.restoredBy),
  ],
);
