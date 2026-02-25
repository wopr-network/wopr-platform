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
  getRole(userId: string, tenantId: string): Role | null {
    const row = this.db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.tenantId, tenantId)))
      .get();
    return row ? (row.role as Role) : null;
  }

  /** Upsert a role for a user in a tenant. */
  setRole(userId: string, tenantId: string, role: Role, grantedBy: string | null): void {
    if (!isValidRole(role)) {
      throw new Error(`Invalid role: ${role}`);
    }

    this.db
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
      })
      .run();
  }

  /** Remove a user's role in a tenant. */
  removeRole(userId: string, tenantId: string): boolean {
    const result = this.db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.tenantId, tenantId)))
      .run();
    return result.changes > 0;
  }

  /** List all users with roles in a given tenant. */
  listByTenant(tenantId: string): UserRoleRow[] {
    const rows = this.db
      .select()
      .from(userRoles)
      .where(eq(userRoles.tenantId, tenantId))
      .orderBy(sql`${userRoles.grantedAt} DESC`)
      .all();
    return rows.map(toRow);
  }

  /** List all platform admins (users with platform_admin role in the sentinel tenant). */
  listPlatformAdmins(): UserRoleRow[] {
    const rows = this.db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.tenantId, RoleStore.PLATFORM_TENANT), eq(userRoles.role, "platform_admin")))
      .orderBy(sql`${userRoles.grantedAt} DESC`)
      .all();
    return rows.map(toRow);
  }

  /** Check if a user is a platform admin. */
  isPlatformAdmin(userId: string): boolean {
    const row = this.db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(userRoles.tenantId, RoleStore.PLATFORM_TENANT),
          eq(userRoles.role, "platform_admin"),
        ),
      )
      .get();
    return row != null;
  }

  /** Count the number of platform admins. */
  countPlatformAdmins(): number {
    const row = this.db
      .select({ count: count() })
      .from(userRoles)
      .where(and(eq(userRoles.tenantId, RoleStore.PLATFORM_TENANT), eq(userRoles.role, "platform_admin")))
      .get();
    return row?.count ?? 0;
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
