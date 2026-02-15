import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Recovery events table — tracks node failure recovery operations.
 * Each event represents one recovery process for a failed node.
 */
export const recoveryEvents = sqliteTable(
  "recovery_events",
  {
    /** Recovery event UUID */
    id: text("id").primaryKey(),
    /** Node that failed and triggered recovery */
    nodeId: text("node_id").notNull(),
    /** What triggered recovery: heartbeat_timeout | manual */
    trigger: text("trigger").notNull(),
    /** Recovery status: in_progress | completed | partial */
    status: text("status").notNull(),
    /** Total number of tenants to recover */
    tenantsTotal: integer("tenants_total"),
    /** Number of tenants successfully recovered */
    tenantsRecovered: integer("tenants_recovered"),
    /** Number of tenants that failed recovery */
    tenantsFailed: integer("tenants_failed"),
    /** Number of tenants waiting for capacity */
    tenantsWaiting: integer("tenants_waiting"),
    /** Unix epoch seconds when recovery started */
    startedAt: integer("started_at").notNull(),
    /** Unix epoch seconds when recovery completed */
    completedAt: integer("completed_at"),
    /** Full recovery report as JSON */
    reportJson: text("report_json"),
  },
  (table) => [
    index("idx_recovery_events_node").on(table.nodeId),
    index("idx_recovery_events_status").on(table.status),
  ],
);

/**
 * Recovery items table — tracks per-tenant recovery status.
 * Each item represents one tenant being recovered during a recovery event.
 */
export const recoveryItems = sqliteTable(
  "recovery_items",
  {
    /** Recovery item UUID */
    id: text("id").primaryKey(),
    /** Parent recovery event ID */
    recoveryEventId: text("recovery_event_id").notNull(),
    /** Tenant being recovered */
    tenant: text("tenant").notNull(),
    /** Source node (the one that failed) */
    sourceNode: text("source_node").notNull(),
    /** Target node (where tenant was restored to) */
    targetNode: text("target_node"),
    /** Backup key used for restoration */
    backupKey: text("backup_key"),
    /** Recovery status: recovered | failed | skipped | waiting */
    status: text("status").notNull(),
    /** Failure or skip reason */
    reason: text("reason"),
    /** Unix epoch seconds when item recovery started */
    startedAt: integer("started_at"),
    /** Unix epoch seconds when item recovery completed */
    completedAt: integer("completed_at"),
  },
  (table) => [
    index("idx_recovery_items_event").on(table.recoveryEventId),
    index("idx_recovery_items_tenant").on(table.tenant),
  ],
);
