import { bigint, integer, pgTable, text } from "drizzle-orm/pg-core";

export const onboardingScripts = pgTable("onboarding_scripts", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  version: integer("version").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  updatedBy: text("updated_by"),
});
