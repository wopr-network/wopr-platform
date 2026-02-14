/**
 * tRPC usage router — meter event queries, usage summaries.
 *
 * Provides typed procedures for quota checking and tier management.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { TierStore } from "../../monetization/quotas/tier-definitions.js";
import { protectedProcedure, router } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface UsageRouterDeps {
  getTierStore: () => TierStore;
}

let _deps: UsageRouterDeps | null = null;

export function setUsageRouterDeps(deps: UsageRouterDeps): void {
  _deps = deps;
}

function deps(): UsageRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Usage not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const usageRouter = router({
  /** Get quota usage vs limits for a tier. */
  quota: protectedProcedure
    .input(
      z.object({
        tier: z.string().default("free"),
        activeInstances: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const { getTierStore } = deps();
      const { buildQuotaUsage } = await import("../../monetization/quotas/quota-check.js");

      const tier = getTierStore().get(input.tier);
      if (!tier) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Unknown tier: ${input.tier}` });
      }

      return buildQuotaUsage(tier, input.activeInstances);
    }),

  /** Check whether an instance creation would be allowed. */
  quotaCheck: protectedProcedure
    .input(
      z.object({
        tier: z.string().default("free"),
        activeInstances: z.number().int().min(0),
        softCap: z.boolean().default(false),
      }),
    )
    .query(async ({ input }) => {
      const { getTierStore } = deps();
      const { checkInstanceQuota } = await import("../../monetization/quotas/quota-check.js");

      const tier = getTierStore().get(input.tier);
      if (!tier) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Unknown tier: ${input.tier}` });
      }

      return checkInstanceQuota(tier, input.activeInstances, {
        softCapEnabled: input.softCap,
        gracePeriodMs: 7 * 24 * 60 * 60 * 1000,
      });
    }),

  /** List all available plan tiers. */
  tiers: protectedProcedure.query(() => {
    const { getTierStore } = deps();
    return { tiers: getTierStore().list() };
  }),

  /** Get a specific tier's details. */
  tier: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(({ input }) => {
    const { getTierStore } = deps();
    const tier = getTierStore().get(input.id);
    if (!tier) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Unknown tier: ${input.id}` });
    }
    return tier;
  }),

  /** Get Docker resource constraints for a tier. */
  resourceLimits: protectedProcedure.input(z.object({ tierId: z.string().min(1) })).query(async ({ input }) => {
    const { getTierStore } = deps();
    const { buildResourceLimits } = await import("../../monetization/quotas/resource-limits.js");

    const tier = getTierStore().get(input.tierId);
    if (!tier) {
      throw new TRPCError({ code: "NOT_FOUND", message: `Unknown tier: ${input.tierId}` });
    }

    return buildResourceLimits(tier);
  }),
});
