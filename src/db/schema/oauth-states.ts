import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

export const oauthStates = pgTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    provider: text("provider").notNull(),
    userId: text("user_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    token: text("token"),
    status: text("status").notNull().default("pending"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_oauth_states_expires").on(table.expiresAt)],
);
