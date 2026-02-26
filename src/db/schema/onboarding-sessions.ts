import { index, integer, pgTable, text } from "drizzle-orm/pg-core";

export const onboardingSessions = pgTable(
  "onboarding_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    anonymousId: text("anonymous_id"),
    woprSessionName: text("wopr_session_name").notNull().unique(),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    budgetUsedCents: integer("budget_used_cents").notNull().default(0),
  },
  (t) => [
    index("onboarding_sessions_user_id_idx").on(t.userId),
    index("onboarding_sessions_anonymous_id_idx").on(t.anonymousId),
  ],
);
