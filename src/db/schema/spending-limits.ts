import { bigint, pgTable, real, text } from "drizzle-orm/pg-core";

export const tenantSpendingLimits = pgTable("tenant_spending_limits", {
  tenantId: text("tenant_id").primaryKey(),
  globalAlertAt: real("global_alert_at"),
  globalHardCap: real("global_hard_cap"),
  perCapabilityJson: text("per_capability_json"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
