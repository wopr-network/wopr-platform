/**
 * tRPC billing router — credits balance, history, checkout, spending limits.
 *
 * Mirrors the existing Hono billing routes but with end-to-end type safety.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { CreditAdjustmentStore } from "../../admin/credits/adjustment-store.js";
import type { MeterAggregator } from "../../monetization/metering/aggregator.js";
import type { CreditPriceMap } from "../../monetization/stripe/credit-prices.js";
import type { TenantCustomerStore } from "../../monetization/stripe/tenant-store.js";
import type { StripeUsageReporter } from "../../monetization/stripe/usage-reporter.js";
import { protectedProcedure, router } from "../init.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const tenantIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const urlSchema = z.string().url().max(2048);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_-]+$/i);

// ---------------------------------------------------------------------------
// Deps — injected at startup
// ---------------------------------------------------------------------------

export interface BillingRouterDeps {
  stripe: {
    checkout: { sessions: { create: (...args: unknown[]) => Promise<{ id: string; url: string | null }> } };
    billingPortal: { sessions: { create: (...args: unknown[]) => Promise<{ url: string }> } };
  };
  tenantStore: TenantCustomerStore;
  creditStore: CreditAdjustmentStore;
  meterAggregator: MeterAggregator;
  usageReporter: StripeUsageReporter;
  priceMap: CreditPriceMap | undefined;
}

let _deps: BillingRouterDeps | null = null;

export function setBillingRouterDeps(deps: BillingRouterDeps): void {
  _deps = deps;
}

function deps(): BillingRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Billing not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const billingRouter = router({
  /** Get credits balance for a tenant. */
  creditsBalance: protectedProcedure.input(z.object({ tenant: tenantIdSchema })).query(({ input }) => {
    const { creditStore } = deps();
    const balance = creditStore.getBalance(input.tenant);
    return { tenant: input.tenant, balance_cents: balance };
  }),

  /** Get credit transaction history for a tenant. */
  creditsHistory: protectedProcedure
    .input(
      z.object({
        tenant: tenantIdSchema,
        type: z.enum(["grant", "refund", "correction"]).optional(),
        from: z.number().int().optional(),
        to: z.number().int().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ input }) => {
      const { creditStore } = deps();
      const { tenant, ...filters } = input;
      return creditStore.listTransactions(tenant, filters);
    }),

  /** Create a Stripe Checkout session for credit purchase. */
  creditsCheckout: protectedProcedure
    .input(
      z.object({
        tenant: tenantIdSchema,
        priceId: z.string().min(1).max(256),
        successUrl: urlSchema,
        cancelUrl: urlSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const { stripe, tenantStore } = deps();
      const { createCreditCheckoutSession } = await import("../../monetization/stripe/checkout.js");
      const session = await createCreditCheckoutSession(stripe as never, tenantStore, input);
      return { url: session.url, sessionId: session.id };
    }),

  /** Create a Stripe Customer Portal session. */
  portalSession: protectedProcedure
    .input(z.object({ tenant: tenantIdSchema, returnUrl: urlSchema }))
    .mutation(async ({ input }) => {
      const { stripe, tenantStore } = deps();
      const { createPortalSession } = await import("../../monetization/stripe/portal.js");
      const session = await createPortalSession(stripe as never, tenantStore, input);
      return { url: session.url };
    }),

  /** Query current-period usage summaries. */
  usage: protectedProcedure
    .input(
      z.object({
        tenant: tenantIdSchema,
        capability: identifierSchema.optional(),
        provider: identifierSchema.optional(),
        startDate: z.number().int().positive().optional(),
        endDate: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      const { meterAggregator } = deps();
      // Enforce tenant isolation if token is tenant-scoped
      if (ctx.tenantId && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }

      let summaries = meterAggregator.querySummaries(input.tenant, {
        since: input.startDate,
        until: input.endDate,
        limit: input.limit,
      });

      if (input.capability) {
        summaries = summaries.filter((s) => s.capability === input.capability);
      }
      if (input.provider) {
        summaries = summaries.filter((s) => s.provider === input.provider);
      }

      return { tenant: input.tenant, usage: summaries };
    }),

  /** Get total spend for current or specified period. */
  usageSummary: protectedProcedure
    .input(
      z.object({
        tenant: tenantIdSchema,
        startDate: z.number().int().positive().optional(),
      }),
    )
    .query(({ input, ctx }) => {
      const { meterAggregator } = deps();
      if (ctx.tenantId && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }

      const since = input.startDate ?? Math.floor(Date.now() / 3_600_000) * 3_600_000;
      const total = meterAggregator.getTenantTotal(input.tenant, since);

      return {
        tenant: input.tenant,
        period_start: since,
        total_cost: total.totalCost,
        total_charge: total.totalCharge,
        event_count: total.eventCount,
      };
    }),

  /** Get historical billing reports sent to Stripe. */
  usageHistory: protectedProcedure
    .input(
      z.object({
        tenant: tenantIdSchema,
        limit: z.number().int().positive().max(1000).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      const { usageReporter } = deps();
      if (ctx.tenantId && input.tenant !== ctx.tenantId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }

      const reports = usageReporter.queryReports(input.tenant, { limit: input.limit });
      return { tenant: input.tenant, reports };
    }),
});
