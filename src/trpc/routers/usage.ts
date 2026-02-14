/**
 * tRPC usage router — quota checks and resource limits.
 *
 * Uses the credit-based billing model (no tiers).
 * Instance limits come from quota-check.ts; resource limits from resource-limits.ts.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../init.js";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const usageRouter = router({
  /** Check quota usage for the current billing model. */
  quota: protectedProcedure
    .input(
      z.object({
        activeInstances: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const { DEFAULT_INSTANCE_LIMITS, checkInstanceQuota } = await import(
        "../../monetization/quotas/quota-check.js"
      );

      const result = checkInstanceQuota(DEFAULT_INSTANCE_LIMITS, input.activeInstances);
      return {
        allowed: result.allowed,
        currentInstances: result.currentInstances,
        maxInstances: result.maxInstances,
      };
    }),

  /** Check whether an instance creation would be allowed. */
  quotaCheck: protectedProcedure
    .input(
      z.object({
        activeInstances: z.number().int().min(0),
        softCap: z.boolean().default(false),
      }),
    )
    .query(async ({ input }) => {
      const { DEFAULT_INSTANCE_LIMITS, checkInstanceQuota } = await import(
        "../../monetization/quotas/quota-check.js"
      );

      return checkInstanceQuota(DEFAULT_INSTANCE_LIMITS, input.activeInstances, {
        softCapEnabled: input.softCap,
        gracePeriodMs: 7 * 24 * 60 * 60 * 1000,
      });
    }),

  /** Get Docker resource constraints for bot containers. */
  resourceLimits: protectedProcedure.query(async () => {
    const { buildResourceLimits, DEFAULT_RESOURCE_CONFIG } = await import(
      "../../monetization/quotas/resource-limits.js"
    );

    return buildResourceLimits(DEFAULT_RESOURCE_CONFIG);
  }),
});
