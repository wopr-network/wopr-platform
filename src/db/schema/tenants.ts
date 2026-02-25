import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey(), // nanoid or crypto.randomUUID()
    name: text("name").notNull(),
    slug: text("slug").unique(),
    type: text("type").notNull(), // "personal" | "org"
    ownerId: text("owner_id").notNull(), // user who created it
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("idx_tenants_slug").on(table.slug),
    index("idx_tenants_owner").on(table.ownerId),
    index("idx_tenants_type").on(table.type),
    check("chk_tenants_type", sql`${table.type} IN ('personal', 'org')`),
  ],
);
