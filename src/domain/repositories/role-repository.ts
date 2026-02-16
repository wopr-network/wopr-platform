/**
 * Repository Interface: RoleRepository (ASYNC)
 *
 * Manages user roles per tenant.
 */
export type Role = "platform_admin" | "tenant_admin" | "user";

export interface UserRoleRow {
  user_id: string;
  tenant_id: string;
  role: string;
  granted_by: string | null;
  granted_at: number;
}

export interface RoleRepository {
  /**
   * Get the role for a user in a specific tenant.
   */
  getRole(userId: string, tenantId: string): Promise<Role | null>;

  /**
   * Upsert a role for a user in a tenant.
   */
  setRole(userId: string, tenantId: string, role: Role, grantedBy: string | null): Promise<void>;

  /**
   * Remove a user's role in a tenant.
   */
  removeRole(userId: string, tenantId: string): Promise<boolean>;

  /**
   * List all users with roles in a given tenant.
   */
  listByTenant(tenantId: string): Promise<UserRoleRow[]>;

  /**
   * List all platform admins.
   */
  listPlatformAdmins(): Promise<UserRoleRow[]>;

  /**
   * Check if a user is a platform admin.
   */
  isPlatformAdmin(userId: string): Promise<boolean>;

  /**
   * Count the number of platform admins.
   */
  countPlatformAdmins(): Promise<number>;
}
