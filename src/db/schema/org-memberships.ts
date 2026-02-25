import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Org membership — maps member tenants to their parent org tenant.
 * A member tenant can belong to at most one org (unique on member_tenant_id).
 * Created by org management flows (WOP-1006). Read-only for this feature.
 */
export const orgMemberships = sqliteTable(
  "org_memberships",
  {
    orgTenantId: text("org_tenant_id").notNull(),
    memberTenantId: text("member_tenant_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgTenantId, table.memberTenantId] }),
    uniqueIndex("idx_org_memberships_member_unique").on(table.memberTenantId),
    index("idx_org_memberships_org").on(table.orgTenantId),
  ],
);
