import { pgTable, text } from "drizzle-orm/pg-core";

export const tenantModelSelection = pgTable("tenant_model_selection", {
  tenantId: text("tenant_id").primaryKey(),
  defaultModel: text("default_model").notNull().default("openrouter/auto"),
  updatedAt: text("updated_at")
    .notNull()
    .$default(() => new Date().toISOString()),
});
