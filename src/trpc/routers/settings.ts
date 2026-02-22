/**
 * tRPC settings router — tenant config, preferences.
 *
 * Provides typed procedures for tenant settings management.
 * Currently exposes tenant key metadata, health status, and notification preferences.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { INotificationPreferencesStore } from "../../email/notification-preferences-store.js";
import { publicProcedure, router, tenantProcedure } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SettingsRouterDeps {
  getNotificationPrefsStore: () => INotificationPreferencesStore;
}

let _deps: SettingsRouterDeps | null = null;

export function setSettingsRouterDeps(deps: SettingsRouterDeps): void {
  _deps = deps;
}

function deps(): SettingsRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Settings not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const settingsRouter = router({
  /** Health check — publicly accessible. */
  health: publicProcedure.query(() => {
    return { status: "ok" as const, service: "wopr-platform" };
  }),

  /** Get tenant configuration summary. */
  tenantConfig: tenantProcedure.query(({ ctx }) => {
    return {
      tenantId: ctx.tenantId,
      configured: true,
    };
  }),

  /** Ping — verify auth and tenant context. */
  ping: tenantProcedure.query(({ ctx }) => {
    return {
      ok: true as const,
      tenantId: ctx.tenantId,
      userId: ctx.user.id,
      timestamp: Date.now(),
    };
  }),

  // -------------------------------------------------------------------------
  // Notification Preferences (WOP-417)
  // -------------------------------------------------------------------------

  /** Get notification preferences for the authenticated tenant. */
  notificationPreferences: tenantProcedure.query(({ ctx }) => {
    const store = deps().getNotificationPrefsStore();
    return store.get(ctx.tenantId);
  }),

  /** Update notification preferences for the authenticated tenant. */
  updateNotificationPreferences: tenantProcedure
    .input(
      z.object({
        billing_low_balance: z.boolean().optional(),
        billing_receipts: z.boolean().optional(),
        billing_auto_topup: z.boolean().optional(),
        agent_channel_disconnect: z.boolean().optional(),
        agent_status_changes: z.boolean().optional(),
        account_role_changes: z.boolean().optional(),
        account_team_invites: z.boolean().optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const store = deps().getNotificationPrefsStore();
      store.update(ctx.tenantId, input);
      return store.get(ctx.tenantId);
    }),
});
