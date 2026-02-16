import type { Role, RoleRepository, UserRoleRow } from "../../domain/repositories/role-repository.js";

export const PLATFORM_TENANT = "*";

export class InMemoryRoleRepository implements RoleRepository {
  private readonly roles = new Map<string, Map<string, { role: Role; grantedBy: string | null; grantedAt: number }>>();

  async getRole(userId: string, tenantId: string): Promise<Role | null> {
    const tenantRoles = this.roles.get(tenantId);
    if (!tenantRoles) return null;
    const entry = tenantRoles.get(userId);
    return entry?.role ?? null;
  }

  async setRole(userId: string, tenantId: string, role: Role, grantedBy: string | null): Promise<void> {
    if (!this.roles.has(tenantId)) {
      this.roles.set(tenantId, new Map());
    }
    this.roles.get(tenantId)?.set(userId, { role, grantedBy, grantedAt: Date.now() });
  }

  async removeRole(userId: string, tenantId: string): Promise<boolean> {
    const tenantRoles = this.roles.get(tenantId);
    if (!tenantRoles) return false;
    const existed = tenantRoles.has(userId);
    tenantRoles.delete(userId);
    return existed;
  }

  async listByTenant(tenantId: string): Promise<UserRoleRow[]> {
    const tenantRoles = this.roles.get(tenantId);
    if (!tenantRoles) return [];
    return Array.from(tenantRoles.entries()).map(([user_id, data]) => ({
      user_id,
      tenant_id: tenantId,
      role: data.role,
      granted_by: data.grantedBy,
      granted_at: data.grantedAt,
    }));
  }

  async listPlatformAdmins(): Promise<UserRoleRow[]> {
    return this.listByTenant(PLATFORM_TENANT);
  }

  async isPlatformAdmin(userId: string): Promise<boolean> {
    const role = await this.getRole(userId, PLATFORM_TENANT);
    return role === "platform_admin";
  }

  async countPlatformAdmins(): Promise<number> {
    const admins = await this.listPlatformAdmins();
    return admins.length;
  }

  reset(): void {
    this.roles.clear();
  }
}
