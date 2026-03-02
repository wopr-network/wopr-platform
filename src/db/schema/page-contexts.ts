import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

export const pageContexts = pgTable(
  "page_contexts",
  {
    userId: text("user_id").primaryKey(),
    currentPage: text("current_page").notNull(),
    pagePrompt: text("page_prompt"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [index("page_contexts_updated_at_idx").on(t.updatedAt)],
);
