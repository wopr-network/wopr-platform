import type { Role } from "../admin/roles/role-store.js";

/**
 * Check if a user with the given role can manage (control/update/destroy) a bot.
 *
 * - platform_admin / tenant_admin: can manage any bot in the tenant
 * - user: can only manage bots they created (createdByUserId matches)
 * - null role or unknown: denied
 */
export function canManageBot(userRole: Role | null, userId: string, botCreatedByUserId: string | null): boolean {
  if (userRole === "platform_admin" || userRole === "tenant_admin") {
    return true;
  }
  if (userRole === "user" && botCreatedByUserId !== null) {
    return userId === botCreatedByUserId;
  }
  return false;
}
