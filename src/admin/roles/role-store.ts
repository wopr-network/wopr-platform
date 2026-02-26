import { and, count, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { userRoles } from "../../db/schema/index.js";

export type Role = "platform_admin" | "tenant_admin" | "user";

export interface UserRoleRow {
  user_id: string;
  tenant_id: string;
  role: string;
  granted_by: string | null;
  granted_at: number;
}

const VALID_ROLES = new Set<string>(["platform_admin", "tenant_admin", "user"]);

/** Validate that a string is a valid Role. */
export function isValidRole(role: string): role is Role {
  return VALID_ROLES.has(role);
}

/**
 * CRUD store for user roles backed by Drizzle ORM.
 *
 * Platform admins are stored with a special sentinel tenant_id ("*") so they
 * can be queried independently of any specific tenant.
 */
export class RoleStore {
  /** Sentinel tenant_id used for platform-wide admin roles. */
  static readonly PLATFORM_TENANT = "*";

  constructor(private readonly db: DrizzleDb) {}

  /** Get the role for a user in a specific tenant (or null if none). */
  async getRole(userId: string, tenantId: string): Promise<Role | null> {
    const rows = await this.db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.tenantId, tenantId)));
    return rows[0] ? (rows[0].role as Role) : null;
  }

  /** Upsert a role for a user in a tenant. */
  async setRole(userId: string, tenantId: string, role: Role, grantedBy: string | null): Promise<void> {
    if (!isValidRole(role)) {
      throw new Error(`Invalid role: ${role}`);
    }

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

  /** Remove a user's role in a tenant. */
  async removeRole(userId: string, tenantId: string): Promise<boolean> {
    const result = await this.db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.tenantId, tenantId)))
      .returning({ userId: userRoles.userId });
    return result.length > 0;
  }

  /** List all users with roles in a given tenant. */
  async listByTenant(tenantId: string): Promise<UserRoleRow[]> {
    const rows = await this.db
      .select()
      .from(userRoles)
      .where(eq(userRoles.tenantId, tenantId))
      .orderBy(sql`${userRoles.grantedAt} DESC`);
    return rows.map(toRow);
  }

  /** List all platform admins (users with platform_admin role in the sentinel tenant). */
  async listPlatformAdmins(): Promise<UserRoleRow[]> {
    const rows = await this.db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.tenantId, RoleStore.PLATFORM_TENANT), eq(userRoles.role, "platform_admin")))
      .orderBy(sql`${userRoles.grantedAt} DESC`);
    return rows.map(toRow);
  }

  /** Check if a user is a platform admin. */
  async isPlatformAdmin(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(userRoles.tenantId, RoleStore.PLATFORM_TENANT),
          eq(userRoles.role, "platform_admin"),
        ),
      );
    return rows.length > 0;
  }

  /** Count the number of platform admins. */
  async countPlatformAdmins(): Promise<number> {
    const rows = await this.db
      .select({ count: count() })
      .from(userRoles)
      .where(and(eq(userRoles.tenantId, RoleStore.PLATFORM_TENANT), eq(userRoles.role, "platform_admin")));
    return rows[0]?.count ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function toRow(row: typeof userRoles.$inferSelect): UserRoleRow {
  return {
    user_id: row.userId,
    tenant_id: row.tenantId,
    role: row.role,
    granted_by: row.grantedBy,
    granted_at: row.grantedAt,
  };
}
