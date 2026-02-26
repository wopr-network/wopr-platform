import { bigint, doublePrecision, index, integer, pgTable, text } from "drizzle-orm/pg-core";

export const sessionUsage = pgTable(
  "session_usage",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    userId: text("user_id"),
    page: text("page"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    model: text("model").notNull(),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_session_usage_session").on(t.sessionId),
    index("idx_session_usage_user").on(t.userId),
    index("idx_session_usage_created").on(t.createdAt),
    index("idx_session_usage_page").on(t.page),
  ],
);
