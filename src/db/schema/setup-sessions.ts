import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

export const setupSessions = pgTable(
  "setup_sessions",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    status: text("status").notNull().default("in_progress"),
    collected: text("collected"),
    dependenciesInstalled: text("dependencies_installed"),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }),
  },
  (t) => [index("setup_sessions_session_id_idx").on(t.sessionId), index("setup_sessions_plugin_id_idx").on(t.pluginId)],
);
