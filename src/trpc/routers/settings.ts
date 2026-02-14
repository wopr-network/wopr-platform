/**
 * tRPC settings router — tenant config, preferences.
 *
 * Provides typed procedures for tenant settings management.
 * Currently exposes tenant key metadata and health status.
 */

import { publicProcedure, router, tenantProcedure } from "../init.js";

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
});
