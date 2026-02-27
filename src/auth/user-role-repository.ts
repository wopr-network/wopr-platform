import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { userRoles } from "../db/schema/user-roles.js";

export interface IUserRoleRepository {
  getTenantIdByUserId(userId: string): Promise<string | null>;
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
}
