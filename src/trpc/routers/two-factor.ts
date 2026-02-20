/**
 * tRPC two-factor router — tenant 2FA mandate management.
 *
 * Exposes procedures for reading and updating per-tenant 2FA requirements.
 * Admin role required to change the mandate; any authenticated user can read it.
 */

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDb } from "../../db/index.js";
import { tenantSecuritySettings } from "../../db/schema/security-settings.js";
import { protectedProcedure, router, tenantProcedure } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface TwoFactorRouterDeps {
  getDb: () => DrizzleDb;
}

let _deps: TwoFactorRouterDeps | null = null;

export function setTwoFactorRouterDeps(deps: TwoFactorRouterDeps): void {
  _deps = deps;
}

function deps(): TwoFactorRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Two-factor router not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertAdmin(user: { id: string; roles?: string[] }): void {
  const roles = user.roles ?? [];
  if (!roles.includes("admin") && !roles.includes("platform_admin") && !roles.includes("tenant_admin")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const twoFactorRouter = router({
  /** Get the 2FA mandate status for the authenticated tenant. */
  getMandateStatus: tenantProcedure.query(async ({ ctx }) => {
    const db = deps().getDb();
    const row = await db
      .select()
      .from(tenantSecuritySettings)
      .where(eq(tenantSecuritySettings.tenantId, ctx.tenantId))
      .get();
    return {
      tenantId: ctx.tenantId,
      requireTwoFactor: row?.requireTwoFactor ?? false,
    };
  }),

  /** Enable or disable the 2FA mandate for the authenticated tenant. Admin only. */
  setMandateStatus: protectedProcedure
    .input(z.object({ tenantId: z.string().min(1), requireTwoFactor: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      assertAdmin(ctx.user);
      const db = deps().getDb();
      const now = Date.now();
      await db
        .insert(tenantSecuritySettings)
        .values({ tenantId: input.tenantId, requireTwoFactor: input.requireTwoFactor, updatedAt: now })
        .onConflictDoUpdate({
          target: tenantSecuritySettings.tenantId,
          set: { requireTwoFactor: input.requireTwoFactor, updatedAt: now },
        });
      return { tenantId: input.tenantId, requireTwoFactor: input.requireTwoFactor };
    }),
});
