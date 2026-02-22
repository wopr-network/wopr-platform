import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    roles: text("roles").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("idx_sessions_user").on(table.userId), index("idx_sessions_expires").on(table.expiresAt)],
);
