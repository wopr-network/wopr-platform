import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Append-only audit log for all node status transitions.
 * Written atomically with every INodeRepository.transition() call.
 */
export const nodeTransitions = pgTable(
  "node_transitions",
  {
    /** UUID */
    id: text("id").primaryKey(),
    /** References nodes.id */
    nodeId: text("node_id").notNull(),
    /** Status before transition */
    fromStatus: text("from_status").notNull(),
    /** Status after transition */
    toStatus: text("to_status").notNull(),
    /** Machine-readable reason: "heartbeat_timeout", "re_registration", "cleanup_complete" */
    reason: text("reason").notNull(),
    /** What triggered it: "heartbeat_watchdog", "recovery_orchestrator", "api:admin" */
    triggeredBy: text("triggered_by").notNull(),
    /** Unix epoch seconds */
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_node_transitions_node").on(t.nodeId), index("idx_node_transitions_created").on(t.createdAt)],
);
