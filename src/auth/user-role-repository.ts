import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { userRoles } from "../db/schema/user-roles.js";

export interface IUserRoleRepository {
  getTenantIdByUserId(userId: string): Promise<string | null>;
  grantRole(userId: string, tenantId: string, role: string, grantedBy: string | null): Promise<void>;
  revokeRole(userId: string, tenantId: string): Promise<boolean>;
  listRolesByUser(userId: string): Promise<Array<{ tenantId: string; role: string }>>;
  listUsersByRole(role: string, tenantId: string): Promise<Array<{ userId: string; role: string }>>;
  isPlatformAdmin(userId: string): Promise<boolean>;
}

export class DrizzleUserRoleRepository implements IUserRoleRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getTenantIdByUserId(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ tenantId: userRoles.tenantId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId))
      .limit(1);
    const tenantId = rows[0]?.tenantId ?? null;
    // Exclude platform-admin sentinel value
    return tenantId === "*" ? null : tenantId;
  }

  async grantRole(userId: string, tenantId: string, role: string, grantedBy: string | null): Promise<void> {
    await this.db
      .insert(userRoles)
      .values({ userId, tenantId, role, grantedBy, grantedAt: Date.now() })
      .onConflictDoUpdate({
        target: [userRoles.userId, userRoles.tenantId],
        set: { role, grantedBy, grantedAt: Date.now() },
      });
  }

  async revokeRole(userId: string, tenantId: string): Promise<boolean> {
    const result = await this.db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.tenantId, tenantId)))
      .returning({ userId: userRoles.userId });
    return result.length > 0;
  }

  async listRolesByUser(userId: string): Promise<Array<{ tenantId: string; role: string }>> {
    return this.db
      .select({ tenantId: userRoles.tenantId, role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
  }

  async listUsersByRole(role: string, tenantId: string): Promise<Array<{ userId: string; role: string }>> {
    return this.db
      .select({ userId: userRoles.userId, role: userRoles.role })
      .from(userRoles)
      .where(and(eq(userRoles.role, role), eq(userRoles.tenantId, tenantId)));
  }

  async isPlatformAdmin(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.tenantId, "*"), eq(userRoles.role, "platform_admin")));
    return rows.length > 0;
  }
}
