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
import { protectedProcedure, publicProcedure, router } from "../init.js";

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
  /** Get credits balance for a tenant. Tenant defaults to ctx.tenantId when omitted. */
  creditsBalance: protectedProcedure.input(z.object({ tenant: tenantIdSchema.optional() })).query(({ input, ctx }) => {
    const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
    if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
    }
    const { creditStore, meterAggregator } = deps();
    const balance = creditStore.getBalance(tenant);

    // Compute 7-day average daily burn from usage summaries.
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const { totalCharge } = meterAggregator.getTenantTotal(tenant, sevenDaysAgo);
    const daily_burn_cents = Math.round(totalCharge / 7);
    const runway_days = daily_burn_cents > 0 ? Math.floor(balance / daily_burn_cents) : null;

    return { tenant, balance_cents: balance, daily_burn_cents, runway_days };
  }),

  /** Get credit transaction history for a tenant. Tenant defaults to ctx.tenantId when omitted. */
  creditsHistory: protectedProcedure
    .input(
      z.object({
        tenant: tenantIdSchema.optional(),
        type: z.enum(["grant", "refund", "correction"]).optional(),
        from: z.number().int().optional(),
        to: z.number().int().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { creditStore } = deps();
      const { tenant: _t, ...filters } = { ...input, tenant };
      return creditStore.listTransactions(tenant, filters);
    }),

  /** Get available credit purchase tiers with real Stripe price IDs. */
  creditOptions: publicProcedure.query(() => {
    const { priceMap } = deps();
    if (!priceMap || priceMap.size === 0) return [];
    const options: Array<{
      priceId: string;
      label: string;
      amountCents: number;
      creditCents: number;
      bonusPercent: number;
    }> = [];
    for (const [priceId, point] of priceMap) {
      options.push({
        priceId,
        label: point.label,
        amountCents: point.amountCents,
        creditCents: point.creditCents,
        bonusPercent: point.bonusPercent,
      });
    }
    // Sort by amountCents ascending for consistent ordering
    options.sort((a, b) => a.amountCents - b.amountCents);
    return options;
  }),

  /** Create a Stripe Checkout session for credit purchase. Tenant defaults to ctx.tenantId when omitted. */
  creditsCheckout: protectedProcedure
    .input(
      z.object({
        tenant: tenantIdSchema.optional(),
        priceId: z.string().min(1).max(256),
        successUrl: urlSchema,
        cancelUrl: urlSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { stripe, tenantStore } = deps();
      const { createCreditCheckoutSession } = await import("../../monetization/stripe/checkout.js");
      const session = await createCreditCheckoutSession(stripe as never, tenantStore, { ...input, tenant });
      return { url: session.url, sessionId: session.id };
    }),

  /** Create a Stripe Customer Portal session. Tenant defaults to ctx.tenantId when omitted. */
  portalSession: protectedProcedure
    .input(z.object({ tenant: tenantIdSchema.optional(), returnUrl: urlSchema }))
    .mutation(async ({ input, ctx }) => {
      const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { stripe, tenantStore } = deps();
      const { createPortalSession } = await import("../../monetization/stripe/portal.js");
      const session = await createPortalSession(stripe as never, tenantStore, { ...input, tenant });
      return { url: session.url };
    }),

  /** Query current-period usage summaries. Tenant defaults to ctx.tenantId when omitted. */
  usage: protectedProcedure
    .input(
      z.object({
        tenant: tenantIdSchema.optional(),
        capability: identifierSchema.optional(),
        provider: identifierSchema.optional(),
        startDate: z.number().int().positive().optional(),
        endDate: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      const { meterAggregator } = deps();
      const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
      // Enforce tenant isolation if token is tenant-scoped
      if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }

      let summaries = meterAggregator.querySummaries(tenant, {
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

      return { tenant, usage: summaries };
    }),

  /** Get total spend for current or specified period. Tenant defaults to ctx.tenantId when omitted. */
  usageSummary: protectedProcedure
    .input(
      z.object({
        tenant: tenantIdSchema.optional(),
        startDate: z.number().int().positive().optional(),
      }),
    )
    .query(({ input, ctx }) => {
      const { meterAggregator } = deps();
      const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }

      const since = input.startDate ?? Math.floor(Date.now() / 3_600_000) * 3_600_000;
      const total = meterAggregator.getTenantTotal(tenant, since);

      return {
        tenant,
        period_start: since,
        total_cost: total.totalCost,
        total_charge: total.totalCharge,
        event_count: total.eventCount,
      };
    }),

  /** Get historical billing reports sent to Stripe. Tenant defaults to ctx.tenantId when omitted. */
  usageHistory: protectedProcedure
    .input(
      z.object({
        tenant: tenantIdSchema.optional(),
        limit: z.number().int().positive().max(1000).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      const { usageReporter } = deps();
      const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }

      const reports = usageReporter.queryReports(tenant, { limit: input.limit });
      return { tenant, reports };
    }),

  /** Get available subscription plans. */
  plans: protectedProcedure.query(() => {
    // TODO(WOP-687): wire to real plan configuration
    return [
      {
        id: "free",
        tier: "free" as const,
        name: "Free",
        price: 0,
        priceLabel: "$0/mo",
        features: {
          instanceCap: 1,
          channels: "1 channel",
          plugins: "Community",
          support: "Community",
          extras: [] as string[],
        },
        recommended: false,
      },
      {
        id: "pro",
        tier: "pro" as const,
        name: "Pro",
        price: 19,
        priceLabel: "$19/mo",
        features: {
          instanceCap: 5,
          channels: "Unlimited",
          plugins: "All plugins",
          support: "Email",
          extras: ["Priority queue"],
        },
        recommended: true,
      },
      {
        id: "team",
        tier: "team" as const,
        name: "Team",
        price: 49,
        priceLabel: "$49/mo",
        features: {
          instanceCap: 20,
          channels: "Unlimited",
          plugins: "All plugins",
          support: "Priority",
          extras: ["Team management", "Audit log"],
        },
        recommended: false,
      },
      {
        id: "enterprise",
        tier: "enterprise" as const,
        name: "Enterprise",
        price: null as number | null,
        priceLabel: "Custom",
        features: {
          instanceCap: null as number | null,
          channels: "Unlimited",
          plugins: "All + custom",
          support: "Dedicated",
          extras: ["SLA", "Custom integrations", "On-prem option"],
        },
        recommended: false,
      },
    ];
  }),

  /** Get current plan tier for the authenticated user. */
  currentPlan: protectedProcedure.query(() => {
    // TODO(WOP-687): wire to real subscription store
    return { tier: "free" as const };
  }),

  /** Change subscription plan. */
  changePlan: protectedProcedure
    .input(z.object({ tier: z.enum(["free", "pro", "team", "enterprise"]) }))
    .mutation(({ input }) => {
      // TODO(WOP-687): wire to Stripe subscription change
      return { tier: input.tier };
    }),

  /** Get inference mode (byok or hosted). */
  inferenceMode: protectedProcedure.query(() => {
    // TODO(WOP-687): wire to tenant settings store
    return { mode: "byok" as const };
  }),

  /** Get provider cost estimates (BYOK users). */
  providerCosts: protectedProcedure.query(() => {
    // TODO(WOP-687): wire to metering aggregator
    return [] as Array<{
      provider: string;
      estimatedCost: number;
      inputTokens: number;
      outputTokens: number;
    }>;
  }),

  /** Get hosted usage summary for current billing period. */
  hostedUsageSummary: protectedProcedure.query(() => {
    // TODO(WOP-687): wire to metering aggregator for hosted usage
    return {
      periodStart: new Date(Date.now() - 30 * 86400000).toISOString(),
      periodEnd: new Date().toISOString(),
      capabilities: [] as Array<{
        capability: string;
        label: string;
        units: number;
        unitLabel: string;
        cost: number;
      }>,
      totalCost: 0,
      includedCredit: 0,
      amountDue: 0,
    };
  }),

  /** Get hosted usage events (detailed breakdown). */
  hostedUsageEvents: protectedProcedure
    .input(
      z
        .object({
          capability: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        })
        .optional(),
    )
    .query(() => {
      // TODO(WOP-687): wire to metering aggregator event query
      return [] as Array<{
        id: string;
        date: string;
        capability: string;
        provider: string;
        units: number;
        unitLabel: string;
        cost: number;
      }>;
    }),

  /** Get spending limits configuration. */
  spendingLimits: protectedProcedure.query(() => {
    // TODO(WOP-687): wire to tenant spending limits store
    return {
      global: { alertAt: null as number | null, hardCap: null as number | null },
      perCapability: {
        transcription: { alertAt: null as number | null, hardCap: null as number | null },
        image_gen: { alertAt: null as number | null, hardCap: null as number | null },
        text_gen: { alertAt: null as number | null, hardCap: null as number | null },
        embeddings: { alertAt: null as number | null, hardCap: null as number | null },
      },
    };
  }),

  /** Update spending limits. */
  updateSpendingLimits: protectedProcedure
    .input(
      z.object({
        global: z.object({
          alertAt: z.number().nonnegative().nullable(),
          hardCap: z.number().nonnegative().nullable(),
        }),
        perCapability: z.record(
          z.string(),
          z.object({
            alertAt: z.number().nonnegative().nullable(),
            hardCap: z.number().nonnegative().nullable(),
          }),
        ),
      }),
    )
    .mutation(({ input }) => {
      // TODO(WOP-687): persist spending limits
      return input;
    }),

  /** Get billing info (payment methods, invoices, email). */
  billingInfo: protectedProcedure.query(() => {
    // TODO(WOP-687): wire to Stripe customer data
    return {
      email: "",
      paymentMethods: [] as Array<{
        id: string;
        brand: string;
        last4: string;
        expiryMonth: number;
        expiryYear: number;
        isDefault: boolean;
      }>,
      invoices: [] as Array<{
        id: string;
        date: string;
        amount: number;
        status: string;
        downloadUrl: string;
      }>,
    };
  }),

  /** Update billing email. */
  updateBillingEmail: protectedProcedure.input(z.object({ email: z.string().email() })).mutation(({ input }) => {
    // TODO(WOP-687): wire to Stripe customer update
    return { email: input.email };
  }),

  /** Remove a payment method. */
  removePaymentMethod: protectedProcedure.input(z.object({ id: z.string().min(1) })).mutation(() => {
    // TODO(WOP-687): wire to Stripe payment method removal
    return { removed: true };
  }),
});
