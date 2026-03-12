/**
 * tRPC two-factor router — tenant 2FA mandate management.
 *
 * Exposes procedures for reading and updating per-tenant 2FA requirements.
 * Admin role required to change the mandate; any authenticated user can read it.
 */

import { TRPCError } from "@trpc/server";
import type { ITwoFactorRepository } from "@wopr-network/platform-core/security/two-factor-repository";
import { router, tenantProcedure } from "@wopr-network/platform-core/trpc";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface TwoFactorRouterDeps {
  twoFactorRepo: ITwoFactorRepository;
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
    return deps().twoFactorRepo.getMandateStatus(ctx.tenantId);
  }),

  /** Enable or disable the 2FA mandate for the authenticated tenant. Admin only. */
  setMandateStatus: tenantProcedure
    .input(z.object({ requireTwoFactor: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      assertAdmin(ctx.user);
      return deps().twoFactorRepo.setMandateStatus(ctx.tenantId, input.requireTwoFactor);
    }),
});
