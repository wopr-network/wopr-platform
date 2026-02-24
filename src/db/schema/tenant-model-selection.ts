import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tenantModelSelection = sqliteTable("tenant_model_selection", {
  tenantId: text("tenant_id").primaryKey(),
  defaultModel: text("default_model").notNull().default("openrouter/auto"),
  updatedAt: text("updated_at")
    .notNull()
    .$default(() => new Date().toISOString()),
});
