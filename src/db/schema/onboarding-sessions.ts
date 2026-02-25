import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const onboardingSessions = sqliteTable("onboarding_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  anonymousId: text("anonymous_id"),
  woprSessionName: text("wopr_session_name").notNull().unique(),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  budgetUsedCents: integer("budget_used_cents").notNull().default(0),
});
