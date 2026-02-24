/**
 * tRPC billing router — credits balance, history, checkout, spending limits.
 *
 * Mirrors the existing Hono billing routes but with end-to-end type safety.
 */

import { TRPCError } from "@trpc/server";
import type Stripe from "stripe";
import { z } from "zod";
import type { CreditAdjustmentStore } from "../../admin/credits/adjustment-store.js";
import type { IAffiliateRepository } from "../../monetization/affiliate/drizzle-affiliate-repository.js";
import {
  ALLOWED_SCHEDULE_INTERVALS,
  ALLOWED_THRESHOLD_CENTS,
  ALLOWED_TOPUP_AMOUNTS_CENTS,
  computeNextScheduleAt,
  type IAutoTopupSettingsRepository,
} from "../../monetization/credits/auto-topup-settings-repository.js";
import type { IDividendRepository } from "../../monetization/credits/dividend-repository.js";
import type { ISpendingLimitsRepository } from "../../monetization/drizzle-spending-limits-repository.js";
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
// Static plan data (WOPR is credit-based, not subscription-based)
// ---------------------------------------------------------------------------

const PLAN_TIERS = [
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
] as const;

// ---------------------------------------------------------------------------
// Deps — injected at startup
// ---------------------------------------------------------------------------

export interface BillingRouterDeps {
  stripe: {
    checkout: { sessions: { create: (...args: unknown[]) => Promise<{ id: string; url: string | null }> } };
    billingPortal: { sessions: { create: (...args: unknown[]) => Promise<{ url: string }> } };
    customers: {
      retrieve: (
        id: string,
        params?: { expand?: string[] },
      ) => Promise<{
        id: string;
        email: string | null;
        invoice_settings?: { default_payment_method?: string | null };
      }>;
      update: (id: string, params: { email: string }) => Promise<{ id: string; email: string | null }>;
    };
    paymentMethods: {
      list: (params: { customer: string; type: string }) => Promise<{
        data: Array<{
          id: string;
          card?: { brand: string; last4: string; exp_month: number; exp_year: number };
        }>;
      }>;
      retrieve: (id: string) => Promise<{ id: string; customer: string | null }>;
      detach: (id: string) => Promise<{ id: string }>;
    };
    invoices: {
      list: (params: { customer: string; limit: number }) => Promise<{
        data: Array<{
          id: string;
          created: number;
          amount_due: number;
          status: string | null;
          invoice_pdf: string | null;
        }>;
      }>;
    };
  };
  tenantStore: TenantCustomerStore;
  creditStore: CreditAdjustmentStore;
  meterAggregator: MeterAggregator;
  usageReporter: StripeUsageReporter;
  priceMap: CreditPriceMap | undefined;
  autoTopupSettingsStore: IAutoTopupSettingsRepository;
  /** Stripe client for payment method lookups. */
  stripeClient: Stripe;
  dividendRepo: IDividendRepository;
  spendingLimitsRepo: ISpendingLimitsRepository;
  affiliateRepo: IAffiliateRepository;
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
    return [...PLAN_TIERS];
  }),

  /** Get current plan tier for the authenticated user. */
  currentPlan: protectedProcedure.query(({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { tenantStore } = deps();
    const mapping = tenantStore.getByTenant(tenant);
    return { tier: (mapping?.tier ?? "free") as "free" | "pro" | "team" | "enterprise" };
  }),

  /** Change subscription plan. */
  changePlan: protectedProcedure
    .input(z.object({ tier: z.enum(["free", "pro", "team", "enterprise"]) }))
    .mutation(({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { tenantStore } = deps();
      tenantStore.setTier(tenant, input.tier);
      return { tier: input.tier };
    }),

  /** Get inference mode (byok or hosted). */
  inferenceMode: protectedProcedure.query(({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { tenantStore } = deps();
    const mode = tenantStore.getInferenceMode(tenant);
    return { mode: mode as "byok" | "hosted" };
  }),

  /** Set inference mode (byok or hosted). */
  setInferenceMode: protectedProcedure
    .input(z.object({ mode: z.enum(["byok", "hosted"]) }))
    .mutation(({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { tenantStore } = deps();
      tenantStore.setInferenceMode(tenant, input.mode);
      return { mode: input.mode };
    }),

  /** Get provider cost estimates (BYOK users). */
  providerCosts: protectedProcedure.query(() => {
    return [] as Array<{
      provider: string;
      estimatedCost: number;
      inputTokens: number;
      outputTokens: number;
    }>;
  }),

  /** Get hosted usage summary for current billing period. */
  hostedUsageSummary: protectedProcedure.query(({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { meterAggregator, creditStore } = deps();

    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);
    const since = periodStart.getTime();

    const summaries = meterAggregator.querySummaries(tenant, { since, limit: 1000 });

    // Group by capability
    const capMap = new Map<string, { units: number; cost: number }>();
    for (const s of summaries) {
      const existing = capMap.get(s.capability) ?? { units: 0, cost: 0 };
      existing.units += s.event_count;
      existing.cost += s.total_charge;
      capMap.set(s.capability, existing);
    }

    const capabilities = Array.from(capMap.entries()).map(([capability, data]) => ({
      capability,
      label: capability.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      units: data.units,
      unitLabel: "events",
      cost: data.cost,
    }));

    const totalCost = capabilities.reduce((sum, c) => sum + c.cost, 0);
    const balance = creditStore.getBalance(tenant);

    return {
      periodStart: periodStart.toISOString(),
      periodEnd: new Date().toISOString(),
      capabilities,
      totalCost,
      includedCredit: balance,
      amountDue: Math.max(0, totalCost - balance),
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
    .query(({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { meterAggregator } = deps();

      const since = input?.from ? new Date(input.from).getTime() : undefined;
      const until = input?.to ? new Date(input.to).getTime() : undefined;

      let summaries = meterAggregator.querySummaries(tenant, {
        since,
        until,
        limit: 500,
      });

      if (input?.capability) {
        summaries = summaries.filter((s) => s.capability === input.capability);
      }

      return summaries.map((s) => ({
        id: `${s.tenant}-${s.capability}-${s.window_start}`,
        date: new Date(s.window_start).toISOString(),
        capability: s.capability,
        provider: s.provider,
        units: s.event_count,
        unitLabel: "events",
        cost: s.total_charge,
      }));
    }),

  /** Get spending limits configuration. */
  spendingLimits: protectedProcedure.query(({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { spendingLimitsRepo } = deps();
    return spendingLimitsRepo.get(tenant);
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
    .mutation(({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { spendingLimitsRepo } = deps();
      spendingLimitsRepo.upsert(tenant, input);
      return spendingLimitsRepo.get(tenant);
    }),

  /** Get billing info (payment methods, invoices, email). */
  billingInfo: protectedProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { stripe, tenantStore } = deps();
    const mapping = tenantStore.getByTenant(tenant);

    if (!mapping) {
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
    }

    const customerId = mapping.stripe_customer_id;

    try {
      const [customer, paymentMethodsResult, invoicesResult] = await Promise.all([
        stripe.customers.retrieve(customerId, { expand: ["invoice_settings.default_payment_method"] }),
        stripe.paymentMethods.list({ customer: customerId, type: "card" }),
        stripe.invoices.list({ customer: customerId, limit: 20 }),
      ]);

      const defaultPmId =
        typeof customer === "object" && "invoice_settings" in customer
          ? (customer.invoice_settings?.default_payment_method as string | null)
          : null;

      const paymentMethods = paymentMethodsResult.data
        .filter((pm) => pm.card)
        .map((pm) => ({
          id: pm.id,
          brand: pm.card?.brand ?? "",
          last4: pm.card?.last4 ?? "",
          expiryMonth: pm.card?.exp_month ?? 0,
          expiryYear: pm.card?.exp_year ?? 0,
          isDefault: pm.id === defaultPmId,
        }));

      const invoices = invoicesResult.data.map((inv) => ({
        id: inv.id,
        date: new Date(inv.created * 1000).toISOString(),
        amount: inv.amount_due,
        status: inv.status ?? "unknown",
        downloadUrl: inv.invoice_pdf ?? "",
      }));

      return {
        email: typeof customer === "object" && "email" in customer ? (customer.email ?? "") : "",
        paymentMethods,
        invoices,
      };
    } catch {
      // Stripe customer may have been deleted or API is down
      return {
        email: "",
        paymentMethods: [],
        invoices: [],
      };
    }
  }),

  /** Update billing email. */
  updateBillingEmail: protectedProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { stripe, tenantStore } = deps();
      const mapping = tenantStore.getByTenant(tenant);

      if (!mapping) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No billing account found" });
      }

      await stripe.customers.update(mapping.stripe_customer_id, { email: input.email });
      return { email: input.email };
    }),

  /** Remove a payment method. */
  removePaymentMethod: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { stripe, tenantStore, creditStore } = deps();

      const { detachPaymentMethod, PaymentMethodOwnershipError } = await import(
        "../../monetization/stripe/payment-methods.js"
      );

      // Guard: prevent removing the last payment method when there's an active
      // billing hold or an outstanding balance (negative credit balance).
      const mapping = tenantStore.getByTenant(tenant);
      if (mapping) {
        const paymentMethods = await stripe.paymentMethods.list({
          customer: mapping.stripe_customer_id,
          type: "card",
        });
        if (paymentMethods.data.length <= 1) {
          const hasBillingHold = mapping.billing_hold === 1;
          const hasOutstandingBalance = creditStore.getBalance(tenant) < 0;
          if (hasBillingHold || hasOutstandingBalance) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Cannot remove last payment method with active billing hold or outstanding balance",
            });
          }
        }
      }

      try {
        await detachPaymentMethod(stripe as never, tenantStore, {
          tenant,
          paymentMethodId: input.id,
        });
        return { removed: true };
      } catch (err) {
        if (err instanceof PaymentMethodOwnershipError) {
          throw new TRPCError({ code: "FORBIDDEN", message: err.message });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to remove payment method",
        });
      }
    }),

  /** Get auto-topup settings for the authenticated tenant. */
  autoTopupSettings: protectedProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { autoTopupSettingsStore, tenantStore, stripeClient } = deps();

    const settings = autoTopupSettingsStore.getByTenant(tenant);

    // Look up payment method last4
    let paymentMethodLast4: string | null = null;
    const mapping = tenantStore.getByTenant(tenant);
    if (mapping) {
      try {
        const methods = await stripeClient.customers.listPaymentMethods(mapping.stripe_customer_id, { limit: 1 });
        if (methods.data.length > 0 && methods.data[0].card) {
          paymentMethodLast4 = methods.data[0].card.last4;
        }
      } catch {
        // Stripe call failed — return null for last4, don't block the response
      }
    }

    return {
      usage_enabled: settings?.usageEnabled ?? false,
      usage_threshold_cents: settings?.usageThresholdCents ?? 500,
      usage_topup_cents: settings?.usageTopupCents ?? 2000,
      schedule_enabled: settings?.scheduleEnabled ?? false,
      schedule_amount_cents: settings?.scheduleAmountCents ?? null,
      schedule_next_at: settings?.scheduleNextAt ?? null,
      payment_method_last4: paymentMethodLast4,
    };
  }),

  /** Update auto-topup settings. Validates amounts against allowed tiers. */
  updateAutoTopupSettings: protectedProcedure
    .input(
      z.object({
        usage_enabled: z.boolean().optional(),
        usage_threshold_cents: z
          .number()
          .int()
          .refine((v) => (ALLOWED_THRESHOLD_CENTS as readonly number[]).includes(v), {
            message: `Must be one of: ${ALLOWED_THRESHOLD_CENTS.join(", ")}`,
          })
          .optional(),
        usage_topup_cents: z
          .number()
          .int()
          .refine((v) => (ALLOWED_TOPUP_AMOUNTS_CENTS as readonly number[]).includes(v), {
            message: `Must be one of: ${ALLOWED_TOPUP_AMOUNTS_CENTS.join(", ")}`,
          })
          .optional(),
        schedule_enabled: z.boolean().optional(),
        schedule_interval: z.enum(ALLOWED_SCHEDULE_INTERVALS).nullable().optional(),
        schedule_amount_cents: z
          .number()
          .int()
          .refine((v) => (ALLOWED_TOPUP_AMOUNTS_CENTS as readonly number[]).includes(v), {
            message: `Must be one of: ${ALLOWED_TOPUP_AMOUNTS_CENTS.join(", ")}`,
          })
          .nullable()
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { autoTopupSettingsStore, tenantStore, stripeClient } = deps();

      // If enabling either mode, verify payment method exists
      const enablingUsage = input.usage_enabled === true;
      const enablingSchedule = input.schedule_enabled === true;

      if (enablingUsage || enablingSchedule) {
        const mapping = tenantStore.getByTenant(tenant);
        if (!mapping) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "No payment method on file. Please add a payment method first.",
          });
        }

        const methods = await stripeClient.customers.listPaymentMethods(mapping.stripe_customer_id, { limit: 1 });
        if (methods.data.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "No payment method on file. Please add a payment method first.",
          });
        }
      }

      // Compute schedule_next_at if schedule is being enabled/changed
      let scheduleNextAt: string | null | undefined;
      if (input.schedule_enabled === true && input.schedule_interval) {
        scheduleNextAt = computeNextScheduleAt(input.schedule_interval);
      } else if (input.schedule_interval === null) {
        scheduleNextAt = null; // Clear next-at when interval is removed
      } else if (input.schedule_enabled === false) {
        scheduleNextAt = null; // Clear next-at when disabling
      }

      autoTopupSettingsStore.upsert(tenant, {
        usageEnabled: input.usage_enabled,
        usageThresholdCents: input.usage_threshold_cents,
        usageTopupCents: input.usage_topup_cents,
        scheduleEnabled: input.schedule_enabled,
        scheduleAmountCents: input.schedule_amount_cents ?? undefined,
        scheduleNextAt: scheduleNextAt,
      });

      const updated = autoTopupSettingsStore.getByTenant(tenant);
      return {
        usage_enabled: updated?.usageEnabled ?? false,
        usage_threshold_cents: updated?.usageThresholdCents ?? 500,
        usage_topup_cents: updated?.usageTopupCents ?? 2000,
        schedule_enabled: updated?.scheduleEnabled ?? false,
        schedule_amount_cents: updated?.scheduleAmountCents ?? null,
        schedule_next_at: updated?.scheduleNextAt ?? null,
        payment_method_last4: null,
      };
    }),

  /** Get current dividend pool stats and user eligibility. */
  dividendStats: protectedProcedure
    .input(z.object({ tenant: tenantIdSchema.optional() }).optional())
    .query(({ input, ctx }) => {
      const tenant = input?.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input?.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { dividendRepo } = deps();
      const stats = dividendRepo.getStats(tenant);
      return {
        pool_cents: stats.poolCents,
        active_users: stats.activeUsers,
        per_user_cents: stats.perUserCents,
        next_distribution_at: stats.nextDistributionAt,
        user_eligible: stats.userEligible,
        user_last_purchase_at: stats.userLastPurchaseAt,
        user_window_expires_at: stats.userWindowExpiresAt,
      };
    }),

  /** Get paginated dividend history for the authenticated user. */
  dividendHistory: protectedProcedure
    .input(
      z
        .object({
          tenant: tenantIdSchema.optional(),
          limit: z.number().int().positive().max(250).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .optional(),
    )
    .query(({ input, ctx }) => {
      const tenant = input?.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input?.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { dividendRepo } = deps();
      const dividends = dividendRepo.getHistory(tenant, input?.limit ?? 50, input?.offset ?? 0);
      return { dividends };
    }),

  /** Get lifetime total dividend credits for the authenticated user. */
  dividendLifetime: protectedProcedure
    .input(z.object({ tenant: tenantIdSchema.optional() }).optional())
    .query(({ input, ctx }) => {
      const tenant = input?.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input?.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { dividendRepo } = deps();
      const total = dividendRepo.getLifetimeTotalCents(tenant);
      return { total_cents: total, tenant };
    }),

  /** Get affiliate code, link, and stats for the authenticated user. */
  affiliateInfo: protectedProcedure.query(({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { affiliateRepo } = deps();
    return affiliateRepo.getStats(tenant);
  }),

  /** Record a referral attribution (called during signup if ref param present). */
  affiliateRecordReferral: protectedProcedure
    .input(
      z.object({
        code: z
          .string()
          .min(1)
          .max(10)
          .regex(/^[a-z0-9]+$/),
        referredTenantId: tenantIdSchema,
      }),
    )
    .mutation(({ input, ctx }) => {
      const callerTenant = ctx.tenantId ?? ctx.user.id;
      if (input.referredTenantId !== callerTenant) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cannot record referral for another tenant" });
      }
      const { affiliateRepo } = deps();
      const codeRecord = affiliateRepo.getByCode(input.code);
      if (!codeRecord) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invalid referral code" });
      }

      if (codeRecord.tenantId === input.referredTenantId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Self-referral is not allowed" });
      }

      const isNew = affiliateRepo.recordReferral(codeRecord.tenantId, input.referredTenantId, input.code);
      return { recorded: isNew, referrer: codeRecord.tenantId };
    }),
});
