import { and, desc, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { userRoles } from "../../db/schema/user-roles.js";
import type { Role, RoleRepository, UserRoleRow } from "../../domain/repositories/role-repository.js";

export const PLATFORM_TENANT = "*";

function mapRowToUserRoleRow(row: typeof userRoles.$inferSelect): UserRoleRow {
  return {
    user_id: row.userId,
    tenant_id: row.tenantId,
    role: row.role,
    granted_by: row.grantedBy,
    granted_at: row.grantedAt,
  };
}

export class DrizzleRoleRepository implements RoleRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getRole(userId: string, tenantId: string): Promise<Role | null> {
    const rows = await this.db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.tenantId, tenantId)))
      .limit(1);
    return (rows[0]?.role as Role) ?? null;
  }

  async setRole(userId: string, tenantId: string, role: Role, grantedBy: string | null): Promise<void> {
    await this.db
      .insert(userRoles)
      .values({
        userId,
        tenantId,
        role,
        grantedBy,
        grantedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [userRoles.userId, userRoles.tenantId],
        set: {
          role,
          grantedBy,
          grantedAt: Date.now(),
        },
      });
  }

  async removeRole(userId: string, tenantId: string): Promise<boolean> {
    const result = await this.db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.tenantId, tenantId)));
    return result.changes > 0;
  }

  async listByTenant(tenantId: string): Promise<UserRoleRow[]> {
    const rows = await this.db
      .select()
      .from(userRoles)
      .where(eq(userRoles.tenantId, tenantId))
      .orderBy(desc(userRoles.grantedAt));
    return rows.map(mapRowToUserRoleRow);
  }

  async listPlatformAdmins(): Promise<UserRoleRow[]> {
    const rows = await this.db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.tenantId, PLATFORM_TENANT), eq(userRoles.role, "platform_admin")))
      .orderBy(desc(userRoles.grantedAt));
    return rows.map(mapRowToUserRoleRow);
  }

  async isPlatformAdmin(userId: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(userRoles.tenantId, PLATFORM_TENANT),
          eq(userRoles.role, "platform_admin"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async countPlatformAdmins(): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)`.as("count") })
      .from(userRoles)
      .where(and(eq(userRoles.tenantId, PLATFORM_TENANT), eq(userRoles.role, "platform_admin")));
    return result[0]?.count ?? 0;
  }
}
