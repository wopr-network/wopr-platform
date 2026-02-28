/**
 * tRPC billing router — credits balance, history, checkout, spending limits.
 *
 * Mirrors the existing Hono billing routes but with end-to-end type safety.
 */

import { TRPCError } from "@trpc/server";
import type { Payram } from "payram";
import { z } from "zod";
import type { AuditLogger } from "../../audit/logger.js";
import type { IAffiliateRepository } from "../../monetization/affiliate/drizzle-affiliate-repository.js";
import { Credit } from "../../monetization/credit.js";
import {
  ALLOWED_SCHEDULE_INTERVALS,
  ALLOWED_THRESHOLDS,
  ALLOWED_TOPUP_AMOUNTS,
  computeNextScheduleAt,
  type IAutoTopupSettingsRepository,
} from "../../monetization/credits/auto-topup-settings-repository.js";
import type { ICreditLedger } from "../../monetization/credits/credit-ledger.js";
import type { IDividendRepository } from "../../monetization/credits/dividend-repository.js";
import type { ISpendingLimitsRepository } from "../../monetization/drizzle-spending-limits-repository.js";
import type { CreditPriceMap, ITenantCustomerStore } from "../../monetization/index.js";
import type { MeterAggregator } from "../../monetization/metering/aggregator.js";
import type { IPaymentProcessor } from "../../monetization/payment-processor.js";
import type { PayRamChargeStore } from "../../monetization/payram/charge-store.js";
import { createPayRamCheckout, MIN_PAYMENT_USD } from "../../monetization/payram/checkout.js";
import { protectedProcedure, publicProcedure, router } from "../init.js";

// ---------------------------------------------------------------------------
// Schedule interval → hours mapping
// ---------------------------------------------------------------------------

const SCHEDULE_INTERVAL_HOURS: Record<"daily" | "weekly" | "monthly", number> = {
  daily: 24,
  weekly: 168,
  monthly: 720,
};

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
  {
    id: "vps",
    tier: "vps" as const,
    name: "VPS",
    price: 15,
    priceLabel: "$15/mo",
    features: {
      instanceCap: 1,
      channels: "Unlimited",
      plugins: "All plugins",
      support: "Email",
      extras: [
        "2GB RAM / 2 vCPU / 20GB SSD",
        "Persistent container",
        "Dedicated hostname",
        "SSH access via Cloudflare Tunnel",
        "Fixed monthly price (no per-credit billing for compute)",
      ],
    },
    recommended: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Deps — injected at startup
// ---------------------------------------------------------------------------

export interface BillingRouterDeps {
  processor: IPaymentProcessor;
  tenantStore: ITenantCustomerStore;
  creditLedger: ICreditLedger;
  meterAggregator: MeterAggregator;
  priceMap: CreditPriceMap | undefined;
  autoTopupSettingsStore: IAutoTopupSettingsRepository;
  dividendRepo: IDividendRepository;
  spendingLimitsRepo: ISpendingLimitsRepository;
  affiliateRepo: IAffiliateRepository;
  payramClient?: Payram;
  payramChargeStore?: PayRamChargeStore;
  auditLogger?: AuditLogger;
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
  creditsBalance: protectedProcedure
    .input(z.object({ tenant: tenantIdSchema.optional() }))
    .query(async ({ input, ctx }) => {
      const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { creditLedger, meterAggregator } = deps();
      const balance = await creditLedger.balance(tenant);

      // Compute 7-day average daily burn from usage summaries.
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const { totalCharge } = await meterAggregator.getTenantTotal(tenant, sevenDaysAgo);
      const daily_burn_cents = Math.round(totalCharge / 7);
      const runway_days = daily_burn_cents > 0 ? Math.floor(balance.toCents() / daily_burn_cents) : null;

      return { tenant, balance_cents: balance.toCentsRounded(), daily_burn_cents, runway_days };
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
    .query(async ({ input, ctx }) => {
      const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { creditLedger } = deps();
      const { tenant: _t, ...filters } = { ...input, tenant };
      const entries = await creditLedger.history(tenant, filters);
      return { entries, total: entries.length };
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
      const { processor } = deps();
      const session = await processor.createCheckoutSession({
        tenant,
        priceId: input.priceId,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      });
      return { url: session.url, sessionId: session.id };
    }),

  /** Create a PayRam crypto payment session. Returns a hosted payment URL. */
  cryptoCheckout: protectedProcedure
    .input(
      z.object({
        amountUsd: z.number().min(MIN_PAYMENT_USD).max(10000),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { payramClient, payramChargeStore } = deps();
      if (!payramClient || !payramChargeStore) {
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: "Crypto payments not configured",
        });
      }
      const result = await createPayRamCheckout(payramClient, payramChargeStore, {
        tenant,
        amountUsd: input.amountUsd,
      });
      return { url: result.url, referenceId: result.referenceId };
    }),

  /** Create a Stripe Customer Portal session. Tenant defaults to ctx.tenantId when omitted. */
  portalSession: protectedProcedure
    .input(z.object({ tenant: tenantIdSchema.optional(), returnUrl: urlSchema }))
    .mutation(async ({ input, ctx }) => {
      const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { processor } = deps();
      if (!processor.supportsPortal()) {
        throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Billing portal not supported" });
      }
      const session = await processor.createPortalSession({ tenant, returnUrl: input.returnUrl });
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
    .query(async ({ input, ctx }) => {
      const { meterAggregator } = deps();
      const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
      // Enforce tenant isolation if token is tenant-scoped
      if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }

      let summaries = await meterAggregator.querySummaries(tenant, {
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
    .query(async ({ input, ctx }) => {
      const { meterAggregator } = deps();
      const tenant = input.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
      }

      const since = input.startDate ?? Math.floor(Date.now() / 3_600_000) * 3_600_000;
      const total = await meterAggregator.getTenantTotal(tenant, since);

      return {
        tenant,
        period_start: since,
        total_cost: total.totalCost,
        total_charge: total.totalCharge,
        event_count: total.eventCount,
      };
    }),

  /** Get available subscription plans. */
  plans: protectedProcedure.query(() => {
    return [...PLAN_TIERS];
  }),

  /** Get current plan tier for the authenticated user. */
  currentPlan: protectedProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { tenantStore } = deps();
    const mapping = await tenantStore.getByTenant(tenant);
    return { tier: (mapping?.tier ?? "free") as "free" | "pro" | "team" | "enterprise" };
  }),

  /** Change subscription plan. */
  changePlan: protectedProcedure
    .input(z.object({ tier: z.enum(["free", "pro", "team", "enterprise"]) }))
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { tenantStore } = deps();
      await tenantStore.setTier(tenant, input.tier);
      return { tier: input.tier };
    }),

  /** Get inference mode (byok or hosted). */
  inferenceMode: protectedProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { tenantStore } = deps();
    const mode = await tenantStore.getInferenceMode(tenant);
    return { mode: mode as "byok" | "hosted" };
  }),

  /** Set inference mode (byok or hosted). */
  setInferenceMode: protectedProcedure
    .input(z.object({ mode: z.enum(["byok", "hosted"]) }))
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { tenantStore } = deps();
      await tenantStore.setInferenceMode(tenant, input.mode);
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
  hostedUsageSummary: protectedProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { meterAggregator, creditLedger } = deps();

    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);
    const since = periodStart.getTime();

    const summaries = await meterAggregator.querySummaries(tenant, { since, limit: 1000 });

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
    const balance = await creditLedger.balance(tenant);

    return {
      periodStart: periodStart.toISOString(),
      periodEnd: new Date().toISOString(),
      capabilities,
      totalCost,
      includedCredit: balance.toCentsFloor(),
      amountDue: Math.max(0, totalCost - balance.toCentsFloor()),
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
    .query(async ({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { meterAggregator } = deps();

      const since = input?.from ? new Date(input.from).getTime() : undefined;
      const until = input?.to ? new Date(input.to).getTime() : undefined;

      let summaries = await meterAggregator.querySummaries(tenant, {
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
  spendingLimits: protectedProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { spendingLimitsRepo } = deps();
    return await spendingLimitsRepo.get(tenant);
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
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { spendingLimitsRepo } = deps();
      await spendingLimitsRepo.upsert(tenant, input);
      return await spendingLimitsRepo.get(tenant);
    }),

  /** Get billing info (payment methods, invoices, email). */
  billingInfo: protectedProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { processor } = deps();

    try {
      const savedMethods = await processor.listPaymentMethods(tenant);
      const paymentMethods = savedMethods.map((pm) => ({
        id: pm.id,
        brand: "",
        last4: pm.label.match(/\d{4}$/)?.[0] ?? "",
        expiryMonth: 0,
        expiryYear: 0,
        isDefault: pm.isDefault,
      }));

      return {
        email: await processor.getCustomerEmail(tenant),
        paymentMethods,
        invoices: [] as Array<{
          id: string;
          date: string;
          amount: number;
          status: string;
          downloadUrl: string;
        }>,
      };
    } catch {
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
      const { tenantStore, processor } = deps();
      const mapping = await tenantStore.getByTenant(tenant);

      if (!mapping) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No billing account found" });
      }

      await processor.updateCustomerEmail(tenant, input.email);
      return { email: input.email };
    }),

  /** Remove a payment method. */
  removePaymentMethod: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { processor, creditLedger, tenantStore } = deps();

      const { PaymentMethodOwnershipError } = await import("../../monetization/payment-processor.js");

      // Guard: prevent removing the last payment method when there's an active
      // billing hold or an outstanding balance (negative credit balance).
      const mapping = await tenantStore.getByTenant(tenant);
      if (mapping) {
        const paymentMethods = await processor.listPaymentMethods(tenant);
        if (paymentMethods.length <= 1) {
          const hasBillingHold = mapping.billing_hold === 1;
          const hasOutstandingBalance = (await creditLedger.balance(tenant)).isNegative();
          if (hasBillingHold || hasOutstandingBalance) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Cannot remove last payment method with active billing hold or outstanding balance",
            });
          }
        }
      }

      try {
        await processor.detachPaymentMethod(tenant, input.id);
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
    const { autoTopupSettingsStore, processor } = deps();

    const settings = await autoTopupSettingsStore.getByTenant(tenant);

    // Look up payment method last4 via IPaymentProcessor
    let paymentMethodLast4: string | null = null;
    try {
      const methods = await processor.listPaymentMethods(tenant);
      const first = methods[0];
      if (first) {
        // Extract last4 from label (e.g. "Visa ending 4242")
        paymentMethodLast4 = first.label.match(/\d{4}$/)?.[0] ?? null;
      }
    } catch {
      // Processor call failed — return null for last4, don't block the response
    }

    return {
      usage_enabled: settings?.usageEnabled ?? false,
      usage_threshold_cents: settings?.usageThreshold.toCents() ?? 500,
      usage_topup_cents: settings?.usageTopup.toCents() ?? 2000,
      schedule_enabled: settings?.scheduleEnabled ?? false,
      schedule_amount_cents: settings?.scheduleAmount?.toCents() ?? null,
      schedule_next_at: settings?.scheduleNextAt ?? null,
      schedule_interval_hours: settings?.scheduleIntervalHours ?? 168,
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
          .refine((v) => (ALLOWED_THRESHOLDS as readonly number[]).includes(v), {
            message: `Must be one of: ${ALLOWED_THRESHOLDS.join(", ")}`,
          })
          .optional(),
        usage_topup_cents: z
          .number()
          .int()
          .refine((v) => (ALLOWED_TOPUP_AMOUNTS as readonly number[]).includes(v), {
            message: `Must be one of: ${ALLOWED_TOPUP_AMOUNTS.join(", ")}`,
          })
          .optional(),
        schedule_enabled: z.boolean().optional(),
        schedule_interval: z.enum(ALLOWED_SCHEDULE_INTERVALS).nullable().optional(),
        schedule_amount_cents: z
          .number()
          .int()
          .refine((v) => (ALLOWED_TOPUP_AMOUNTS as readonly number[]).includes(v), {
            message: `Must be one of: ${ALLOWED_TOPUP_AMOUNTS.join(", ")}`,
          })
          .nullable()
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const tenant = ctx.tenantId ?? ctx.user.id;
      const { autoTopupSettingsStore, processor, auditLogger } = deps();

      // If enabling either mode, verify payment method exists
      const enablingUsage = input.usage_enabled === true;
      const enablingSchedule = input.schedule_enabled === true;

      if (enablingUsage || enablingSchedule) {
        const methods = await processor.listPaymentMethods(tenant);
        if (methods.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "No payment method on file. Please add a payment method first.",
          });
        }
      }

      // Fetch previous settings for audit trail
      const previous = await autoTopupSettingsStore.getByTenant(tenant);

      // Compute schedule_next_at if schedule is being enabled/changed
      let scheduleNextAt: string | null | undefined;
      if (input.schedule_enabled === true && input.schedule_interval) {
        scheduleNextAt = computeNextScheduleAt(input.schedule_interval);
      } else if (input.schedule_interval === null) {
        scheduleNextAt = null; // Clear next-at when interval is removed
      } else if (input.schedule_enabled === false) {
        scheduleNextAt = null; // Clear next-at when disabling
      }

      await autoTopupSettingsStore.upsert(tenant, {
        usageEnabled: input.usage_enabled,
        usageThreshold: input.usage_threshold_cents != null ? Credit.fromCents(input.usage_threshold_cents) : undefined,
        usageTopup: input.usage_topup_cents != null ? Credit.fromCents(input.usage_topup_cents) : undefined,
        scheduleEnabled: input.schedule_enabled,
        scheduleAmount: input.schedule_amount_cents != null ? Credit.fromCents(input.schedule_amount_cents) : undefined,
        scheduleIntervalHours: input.schedule_interval ? SCHEDULE_INTERVAL_HOURS[input.schedule_interval] : undefined,
        scheduleNextAt: scheduleNextAt,
      });

      const updated = await autoTopupSettingsStore.getByTenant(tenant);

      // Emit audit log (fire-and-forget, never breaks the response)
      if (auditLogger) {
        try {
          const snapshotSettings = (s: typeof previous) =>
            s
              ? {
                  usage_enabled: s.usageEnabled,
                  usage_threshold_cents: s.usageThreshold.toCents(),
                  usage_topup_cents: s.usageTopup.toCents(),
                  schedule_enabled: s.scheduleEnabled,
                  schedule_amount_cents: s.scheduleAmount.toCents(),
                  schedule_interval_hours: s.scheduleIntervalHours,
                  schedule_next_at: s.scheduleNextAt,
                }
              : null;

          await auditLogger.log({
            userId: ctx.user.id,
            authMethod: "session",
            action: "billing.auto_topup_update",
            resourceType: "billing",
            resourceId: tenant,
            details: {
              previous: snapshotSettings(previous),
              new: snapshotSettings(updated),
            },
          });
        } catch {
          // Audit logging must never break billing operations
        }
      }

      return {
        usage_enabled: updated?.usageEnabled ?? false,
        usage_threshold_cents: updated?.usageThreshold.toCents() ?? 500,
        usage_topup_cents: updated?.usageTopup.toCents() ?? 2000,
        schedule_enabled: updated?.scheduleEnabled ?? false,
        schedule_amount_cents: updated?.scheduleAmount?.toCents() ?? null,
        schedule_next_at: updated?.scheduleNextAt ?? null,
        schedule_interval_hours: updated?.scheduleIntervalHours ?? 168,
        payment_method_last4: null,
      };
    }),

  /** Get current dividend pool stats and user eligibility. */
  dividendStats: protectedProcedure
    .input(z.object({ tenant: tenantIdSchema.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const tenant = input?.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input?.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { dividendRepo } = deps();
      const stats = await dividendRepo.getStats(tenant);
      return {
        pool_cents: stats.pool.toCents(),
        active_users: stats.activeUsers,
        per_user_cents: stats.perUser.toCents(),
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
    .query(async ({ input, ctx }) => {
      const tenant = input?.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input?.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { dividendRepo } = deps();
      const dividends = await dividendRepo.getHistory(tenant, input?.limit ?? 50, input?.offset ?? 0);
      return { dividends };
    }),

  /** Get lifetime total dividend credits for the authenticated user. */
  dividendLifetime: protectedProcedure
    .input(z.object({ tenant: tenantIdSchema.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const tenant = input?.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input?.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { dividendRepo } = deps();
      const total = await dividendRepo.getLifetimeTotal(tenant);
      return { total_cents: total.toCents(), tenant };
    }),

  /** Get affiliate code, link, and stats for the authenticated user. */
  affiliateInfo: protectedProcedure.query(async ({ ctx }) => {
    const tenant = ctx.tenantId ?? ctx.user.id;
    const { affiliateRepo } = deps();
    return await affiliateRepo.getStats(tenant);
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
    .mutation(async ({ input, ctx }) => {
      const callerTenant = ctx.tenantId ?? ctx.user.id;
      if (input.referredTenantId !== callerTenant) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot record referral for another tenant",
        });
      }
      const { affiliateRepo } = deps();
      const codeRecord = await affiliateRepo.getByCode(input.code);
      if (!codeRecord) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invalid referral code" });
      }

      if (codeRecord.tenantId === input.referredTenantId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Self-referral is not allowed" });
      }

      const isNew = await affiliateRepo.recordReferral(codeRecord.tenantId, input.referredTenantId, input.code, {});
      return { recorded: isNew, referrer: codeRecord.tenantId };
    }),

  /** Get per-member credit usage breakdown for an org. */
  memberUsage: protectedProcedure
    .input(z.object({ tenant: tenantIdSchema.optional() }).optional())
    .query(async ({ input, ctx }) => {
      const tenant = input?.tenant ?? ctx.tenantId ?? ctx.user.id;
      if (input?.tenant && input.tenant !== (ctx.tenantId ?? ctx.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }
      const { creditLedger } = deps();
      const members = await creditLedger.memberUsage(tenant);
      return { tenant, members };
    }),
});
