import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const oauthStates = sqliteTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    provider: text("provider").notNull(),
    userId: text("user_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    token: text("token"),
    status: text("status").notNull().default("pending"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("idx_oauth_states_expires").on(table.expiresAt)],
);
