import { bigint, index, pgTable, serial, text } from "drizzle-orm/pg-core";

export const fleetEventHistory = pgTable(
  "fleet_event_history",
  {
    id: serial("id").primaryKey(),
    eventType: text("event_type").notNull(),
    botId: text("bot_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("fleet_event_history_bot_id_created_at_idx").on(table.botId, table.createdAt),
    index("fleet_event_history_tenant_id_created_at_idx").on(table.tenantId, table.createdAt),
  ],
);
