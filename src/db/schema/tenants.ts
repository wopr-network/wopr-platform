import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text } from "drizzle-orm/pg-core";

export const tenants = pgTable(
  "tenants",
  {
    id: text("id").primaryKey(), // nanoid or crypto.randomUUID()
    name: text("name").notNull(),
    slug: text("slug").unique(),
    type: text("type").notNull(), // "personal" | "org"
    ownerId: text("owner_id").notNull(), // user who created it
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .default(sql`(extract(epoch from now()) * 1000)::bigint`),
  },
  (table) => [
    index("idx_tenants_slug").on(table.slug),
    index("idx_tenants_owner").on(table.ownerId),
    index("idx_tenants_type").on(table.type),
    check("chk_tenants_type", sql`${table.type} IN ('personal', 'org')`),
  ],
);
