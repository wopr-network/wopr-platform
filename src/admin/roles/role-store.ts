import type Database from "better-sqlite3";

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
 * CRUD store for user roles backed by better-sqlite3.
 *
 * Platform admins are stored with a special sentinel tenant_id ("*") so they
 * can be queried independently of any specific tenant.
 */
export class RoleStore {
  private readonly db: Database.Database;

  /** Sentinel tenant_id used for platform-wide admin roles. */
  static readonly PLATFORM_TENANT = "*";

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Get the role for a user in a specific tenant (or null if none). */
  getRole(userId: string, tenantId: string): Role | null {
    const row = this.db
      .prepare("SELECT role FROM user_roles WHERE user_id = ? AND tenant_id = ?")
      .get(userId, tenantId) as { role: string } | undefined;
    return row ? (row.role as Role) : null;
  }

  /** Upsert a role for a user in a tenant. */
  setRole(userId: string, tenantId: string, role: Role, grantedBy: string | null): void {
    if (!isValidRole(role)) {
      throw new Error(`Invalid role: ${role}`);
    }

    this.db
      .prepare(
        `INSERT INTO user_roles (user_id, tenant_id, role, granted_by, granted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, tenant_id) DO UPDATE SET
           role = excluded.role,
           granted_by = excluded.granted_by,
           granted_at = excluded.granted_at`,
      )
      .run(userId, tenantId, role, grantedBy, Date.now());
  }

  /** Remove a user's role in a tenant. */
  removeRole(userId: string, tenantId: string): boolean {
    const result = this.db.prepare("DELETE FROM user_roles WHERE user_id = ? AND tenant_id = ?").run(userId, tenantId);
    return result.changes > 0;
  }

  /** List all users with roles in a given tenant. */
  listByTenant(tenantId: string): UserRoleRow[] {
    return this.db
      .prepare("SELECT * FROM user_roles WHERE tenant_id = ? ORDER BY granted_at DESC")
      .all(tenantId) as UserRoleRow[];
  }

  /** List all platform admins (users with platform_admin role in the sentinel tenant). */
  listPlatformAdmins(): UserRoleRow[] {
    return this.db
      .prepare("SELECT * FROM user_roles WHERE tenant_id = ? AND role = 'platform_admin' ORDER BY granted_at DESC")
      .all(RoleStore.PLATFORM_TENANT) as UserRoleRow[];
  }

  /** Check if a user is a platform admin. */
  isPlatformAdmin(userId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND tenant_id = ? AND role = 'platform_admin'")
      .get(userId, RoleStore.PLATFORM_TENANT);
    return row != null;
  }

  /** Count the number of platform admins. */
  countPlatformAdmins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM user_roles WHERE tenant_id = ? AND role = 'platform_admin'")
      .get(RoleStore.PLATFORM_TENANT) as { count: number };
    return row.count;
  }
}
