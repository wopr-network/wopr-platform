/**
 * tRPC admin router — audit log, tier management, overrides, tenant status.
 *
 * Provides typed procedures for admin-level operations.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { AnalyticsStore } from "../../admin/analytics/analytics-store.js";
import type { AdminAuditLog } from "../../admin/audit-log.js";
import type { BulkOperationsStore } from "../../admin/bulk/bulk-operations-store.js";
import type { CreditAdjustmentStore } from "../../admin/credits/adjustment-store.js";
import type { AdminNotesStore } from "../../admin/notes/notes-store.js";
import type { RateStore } from "../../admin/rates/rate-store.js";
import type { RoleStore } from "../../admin/roles/role-store.js";
import type { TenantStatusStore } from "../../admin/tenant-status/tenant-status-store.js";
import type { AdminUserStore } from "../../admin/users/user-store.js";
import type { BotBilling } from "../../monetization/credits/bot-billing.js";
import type { MeterAggregator } from "../../monetization/metering/aggregator.js";
import { protectedProcedure, router } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AdminRouterDeps {
  getAuditLog: () => AdminAuditLog;
  getCreditStore: () => CreditAdjustmentStore;
  getRateStore?: () => RateStore;
  getUserStore: () => AdminUserStore;
  getTenantStatusStore: () => TenantStatusStore;
  getBotBilling?: () => BotBilling;
  getAnalyticsStore?: () => AnalyticsStore;
  getNotesStore?: () => AdminNotesStore;
  getMeterAggregator?: () => MeterAggregator;
  getRoleStore?: () => RoleStore;
  getBulkStore?: () => BulkOperationsStore;
}

let _deps: AdminRouterDeps | null = null;

export function setAdminRouterDeps(deps: AdminRouterDeps): void {
  _deps = deps;
}

function deps(): AdminRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Admin not initialized" });
  return _deps;
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const tenantIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

const VALID_STATUSES = ["active", "suspended", "grace_period", "dormant"] as const;
const VALID_ROLES = ["platform_admin", "tenant_admin", "user"] as const;
const VALID_SORT_BY = ["last_seen", "created_at", "balance", "agent_count"] as const;
const VALID_SORT_ORDER = ["asc", "desc"] as const;

const dateRangeSchema = z.object({
  from: z.number().int().positive(),
  to: z.number().int().positive(),
});

const VALID_CSV_SECTIONS = [
  "revenue_overview",
  "revenue_breakdown",
  "margin_by_capability",
  "provider_spend",
  "tenant_health",
  "time_series",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requirePlatformAdmin(roles: string[]): void {
  if (!roles.includes("platform_admin")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Platform admin role required" });
  }
}

function resolveRange(input: { from?: number; to?: number }): { from: number; to: number } {
  const to = input.to ?? Date.now();
  const from = input.from ?? to - 30 * 24 * 60 * 60 * 1000; // 30 days
  return { from, to };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const adminRouter = router({
  /** Query admin audit log entries. */
  auditLog: protectedProcedure
    .input(
      z.object({
        admin: z.string().optional(),
        action: z.string().optional(),
        category: z.string().optional(),
        tenant: z.string().optional(),
        from: z.number().int().optional(),
        to: z.number().int().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ input }) => {
      const { getAuditLog } = deps();
      return getAuditLog().query(input);
    }),

  /** Export admin audit log as CSV. */
  auditLogExport: protectedProcedure
    .input(
      z.object({
        admin: z.string().optional(),
        action: z.string().optional(),
        category: z.string().optional(),
        tenant: z.string().optional(),
        from: z.number().int().optional(),
        to: z.number().int().optional(),
      }),
    )
    .query(({ input }) => {
      const { getAuditLog } = deps();
      return { csv: getAuditLog().exportCsv(input) };
    }),

  /** Get credits balance for a tenant. */
  creditsBalance: protectedProcedure.input(z.object({ tenantId: tenantIdSchema })).query(({ input }) => {
    const { getCreditStore } = deps();
    const balance = getCreditStore().getBalance(input.tenantId);
    return { tenant: input.tenantId, balance_cents: balance };
  }),

  /** Grant credits to a tenant. */
  creditsGrant: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        amount_cents: z.number().int().positive(),
        reason: z.string().min(1),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { getCreditStore } = deps();
      return getCreditStore().grant(input.tenantId, input.amount_cents, input.reason, ctx.user?.id ?? "unknown");
    }),

  /** Refund credits from a tenant. */
  creditsRefund: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        amount_cents: z.number().int().positive(),
        reason: z.string().min(1),
        reference_ids: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { getCreditStore } = deps();
      return getCreditStore().refund(
        input.tenantId,
        input.amount_cents,
        input.reason,
        ctx.user?.id ?? "unknown",
        input.reference_ids,
      );
    }),

  /** Apply a credit correction. */
  creditsCorrection: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        amount_cents: z.number().int(),
        reason: z.string().min(1),
      }),
    )
    .mutation(({ input, ctx }) => {
      const { getCreditStore } = deps();
      return getCreditStore().correction(input.tenantId, input.amount_cents, input.reason, ctx.user?.id ?? "unknown");
    }),

  /** List credit transactions for a tenant. */
  creditsTransactions: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        type: z.enum(["grant", "refund", "correction"]).optional(),
        from: z.number().int().optional(),
        to: z.number().int().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ input }) => {
      const { getCreditStore } = deps();
      const { tenantId, ...filters } = input;
      return getCreditStore().listTransactions(tenantId, filters);
    }),

  /** List users with filters. */
  usersList: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        status: z.enum(VALID_STATUSES).optional(),
        role: z.enum(VALID_ROLES).optional(),
        hasCredits: z.boolean().optional(),
        lowBalance: z.boolean().optional(),
        sortBy: z.enum(VALID_SORT_BY).optional(),
        sortOrder: z.enum(VALID_SORT_ORDER).optional(),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ input }) => {
      const { getUserStore } = deps();
      return getUserStore().list(input);
    }),

  /** Get a specific user by ID. */
  usersGet: protectedProcedure.input(z.object({ userId: z.string().min(1) })).query(({ input }) => {
    const { getUserStore } = deps();
    const user = getUserStore().getById(input.userId);
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    }
    return user;
  }),

  // -------------------------------------------------------------------------
  // Tenant Status Management (WOP-412)
  // -------------------------------------------------------------------------

  /** Get tenant account status. */
  tenantStatus: protectedProcedure.input(z.object({ tenantId: tenantIdSchema })).query(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getTenantStatusStore } = deps();
    const row = getTenantStatusStore().get(input.tenantId);
    return row ?? { tenantId: input.tenantId, status: "active" };
  }),

  /** Suspend a tenant account. Requires platform_admin role. */
  suspendTenant: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        reason: z.string().min(1).max(1000),
        notifyByEmail: z.boolean().optional().default(false),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getTenantStatusStore, getAuditLog, getBotBilling } = deps();
      const store = getTenantStatusStore();
      const adminUserId = ctx.user?.id ?? "unknown";

      // Check current status
      const current = store.getStatus(input.tenantId);
      if (current === "banned") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot suspend a banned account",
        });
      }
      if (current === "suspended") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Account is already suspended",
        });
      }

      // Suspend the tenant
      store.suspend(input.tenantId, input.reason, adminUserId);

      // Suspend all bots for this tenant
      let suspendedBots: string[] = [];
      if (getBotBilling) {
        suspendedBots = getBotBilling().suspendAllForTenant(input.tenantId);
      }

      // Audit log
      getAuditLog().log({
        adminUser: adminUserId,
        action: "tenant.suspend",
        category: "account",
        targetTenant: input.tenantId,
        details: {
          reason: input.reason,
          previousStatus: current,
          notifyByEmail: input.notifyByEmail,
          suspendedBots,
        },
      });

      return {
        tenantId: input.tenantId,
        status: "suspended" as const,
        reason: input.reason,
        suspendedBots,
      };
    }),

  /** Reactivate a suspended tenant account. Requires platform_admin role. */
  reactivateTenant: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        notifyByEmail: z.boolean().optional().default(false),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getTenantStatusStore, getAuditLog } = deps();
      const store = getTenantStatusStore();
      const adminUserId = ctx.user?.id ?? "unknown";

      // Check current status
      const current = store.getStatus(input.tenantId);
      if (current === "banned") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot reactivate a banned account",
        });
      }
      if (current === "active") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Account is already active",
        });
      }

      // Reactivate the tenant
      store.reactivate(input.tenantId, adminUserId);

      // Audit log
      getAuditLog().log({
        adminUser: adminUserId,
        action: "tenant.reactivate",
        category: "account",
        targetTenant: input.tenantId,
        details: {
          previousStatus: current,
          notifyByEmail: input.notifyByEmail,
        },
      });

      return {
        tenantId: input.tenantId,
        status: "active" as const,
      };
    }),

  /** Ban a tenant account permanently. Requires platform_admin role and typed confirmation. */
  banTenant: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        reason: z.string().min(1).max(1000),
        tosReference: z.string().min(1).max(500),
        /** Must type the exact confirmation string to proceed. */
        confirmName: z.string().min(1),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getTenantStatusStore, getAuditLog, getCreditStore, getBotBilling } = deps();
      const store = getTenantStatusStore();
      const adminUserId = ctx.user?.id ?? "unknown";

      // Verify typed confirmation
      const expectedConfirmation = `BAN ${input.tenantId}`;
      if (input.confirmName !== expectedConfirmation) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Type "${expectedConfirmation}" to confirm the ban`,
        });
      }

      // Check current status
      const current = store.getStatus(input.tenantId);
      if (current === "banned") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Account is already banned",
        });
      }

      // Suspend all bots
      let suspendedBots: string[] = [];
      if (getBotBilling) {
        suspendedBots = getBotBilling().suspendAllForTenant(input.tenantId);
      }

      // Auto-refund remaining credits
      let refundedCents = 0;
      const balance = getCreditStore().getBalance(input.tenantId);
      if (balance > 0) {
        getCreditStore().refund(input.tenantId, balance, `Auto-refund on account ban: ${input.reason}`, adminUserId);
        refundedCents = balance;
      }

      // Ban the tenant
      store.ban(input.tenantId, input.reason, adminUserId);

      // Audit log
      getAuditLog().log({
        adminUser: adminUserId,
        action: "tenant.ban",
        category: "account",
        targetTenant: input.tenantId,
        details: {
          reason: input.reason,
          tosReference: input.tosReference,
          previousStatus: current,
          suspendedBots,
          refundedCents,
        },
      });

      return {
        tenantId: input.tenantId,
        status: "banned" as const,
        reason: input.reason,
        refundedCents,
        suspendedBots,
      };
    }),

  // -------------------------------------------------------------------------
  // Rate Table Management (WOP-464)
  // -------------------------------------------------------------------------

  /** List sell rates with optional filters. */
  ratesListSell: protectedProcedure
    .input(
      z.object({
        capability: z.string().optional(),
        isActive: z.boolean().optional(),
        limit: z.number().int().positive().max(250).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getRateStore } = deps();
      if (!getRateStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
      }
      return getRateStore().listSellRates(input);
    }),

  /** Create a sell rate. */
  ratesCreateSell: protectedProcedure
    .input(
      z.object({
        capability: z.string().min(1),
        displayName: z.string().min(1).max(200),
        unit: z.string().min(1).max(100),
        priceUsd: z.number().positive(),
        model: z.string().max(200).optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().min(0).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getRateStore } = deps();
      if (!getRateStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
      }
      return getRateStore().createSellRate(input);
    }),

  /** Update a sell rate. */
  ratesUpdateSell: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        capability: z.string().min(1).optional(),
        displayName: z.string().min(1).max(200).optional(),
        unit: z.string().min(1).max(100).optional(),
        priceUsd: z.number().positive().optional(),
        model: z.string().max(200).optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().min(0).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getRateStore } = deps();
      if (!getRateStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
      }
      const { id, ...updates } = input;
      return getRateStore().updateSellRate(id, updates);
    }),

  /** Delete a sell rate. */
  ratesDeleteSell: protectedProcedure.input(z.object({ id: z.string().min(1) })).mutation(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getRateStore } = deps();
    if (!getRateStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
    }
    const deleted = getRateStore().deleteSellRate(input.id);
    if (!deleted) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Sell rate not found" });
    }
    return { success: true };
  }),

  /** List provider costs with optional filters. */
  ratesListProvider: protectedProcedure
    .input(
      z.object({
        capability: z.string().optional(),
        adapter: z.string().optional(),
        isActive: z.boolean().optional(),
        limit: z.number().int().positive().max(250).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getRateStore } = deps();
      if (!getRateStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
      }
      return getRateStore().listProviderCosts(input);
    }),

  /** Create a provider cost. */
  ratesCreateProvider: protectedProcedure
    .input(
      z.object({
        capability: z.string().min(1),
        adapter: z.string().min(1).max(100),
        model: z.string().max(200).optional(),
        unit: z.string().min(1).max(100),
        costUsd: z.number().positive(),
        priority: z.number().int().min(0).optional(),
        latencyClass: z.enum(["fast", "standard", "batch"]).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getRateStore } = deps();
      if (!getRateStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
      }
      return getRateStore().createProviderCost(input);
    }),

  /** Update a provider cost. */
  ratesUpdateProvider: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        capability: z.string().min(1).optional(),
        adapter: z.string().min(1).max(100).optional(),
        model: z.string().max(200).optional(),
        unit: z.string().min(1).max(100).optional(),
        costUsd: z.number().positive().optional(),
        priority: z.number().int().min(0).optional(),
        latencyClass: z.enum(["fast", "standard", "batch"]).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getRateStore } = deps();
      if (!getRateStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
      }
      const { id, ...updates } = input;
      return getRateStore().updateProviderCost(id, updates);
    }),

  /** Delete a provider cost. */
  ratesDeleteProvider: protectedProcedure.input(z.object({ id: z.string().min(1) })).mutation(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getRateStore } = deps();
    if (!getRateStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
    }
    const deleted = getRateStore().deleteProviderCost(input.id);
    if (!deleted) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Provider cost not found" });
    }
    return { success: true };
  }),

  /** Get margin report. */
  ratesMargins: protectedProcedure.input(z.object({ capability: z.string().optional() })).query(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getRateStore } = deps();
    if (!getRateStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
    }
    return { margins: getRateStore().getMarginReport(input.capability) };
  }),

  // -------------------------------------------------------------------------
  // Revenue Analytics (WOP-408)
  // -------------------------------------------------------------------------

  /** Revenue overview cards: credits sold, consumed, provider cost, margin. */
  analyticsRevenue: protectedProcedure.input(dateRangeSchema.partial()).query(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getAnalyticsStore } = deps();
    if (!getAnalyticsStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Analytics not initialized" });
    }
    return getAnalyticsStore().getRevenueOverview(resolveRange(input));
  }),

  /** Credit float: total unspent credits across all tenants. */
  analyticsFloat: protectedProcedure.query(({ ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getAnalyticsStore } = deps();
    if (!getAnalyticsStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Analytics not initialized" });
    }
    return getAnalyticsStore().getFloat();
  }),

  /** Revenue breakdown by category and capability. */
  analyticsRevenueBreakdown: protectedProcedure.input(dateRangeSchema.partial()).query(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getAnalyticsStore } = deps();
    if (!getAnalyticsStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Analytics not initialized" });
    }
    return { breakdown: getAnalyticsStore().getRevenueBreakdown(resolveRange(input)) };
  }),

  /** Margin by capability: revenue, cost, margin for each capability. */
  analyticsMarginByCapability: protectedProcedure.input(dateRangeSchema.partial()).query(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getAnalyticsStore } = deps();
    if (!getAnalyticsStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Analytics not initialized" });
    }
    return { margins: getAnalyticsStore().getMarginByCapability(resolveRange(input)) };
  }),

  /** Provider spend breakdown. */
  analyticsProviderSpend: protectedProcedure.input(dateRangeSchema.partial()).query(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getAnalyticsStore } = deps();
    if (!getAnalyticsStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Analytics not initialized" });
    }
    return { providers: getAnalyticsStore().getProviderSpend(resolveRange(input)) };
  }),

  /** Tenant health summary. */
  analyticsTenantHealth: protectedProcedure.query(({ ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getAnalyticsStore } = deps();
    if (!getAnalyticsStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Analytics not initialized" });
    }
    return getAnalyticsStore().getTenantHealth();
  }),

  /** Time series data for charts. */
  analyticsTimeSeries: protectedProcedure
    .input(
      z.object({
        from: z.number().int().positive().optional(),
        to: z.number().int().positive().optional(),
        bucketMs: z.number().int().positive().optional(),
      }),
    )
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getAnalyticsStore } = deps();
      if (!getAnalyticsStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Analytics not initialized" });
      }
      const range = resolveRange(input);
      const bucketMs = input.bucketMs ?? 86_400_000; // default 1 day
      return { series: getAnalyticsStore().getTimeSeries(range, bucketMs) };
    }),

  /** Export analytics data as CSV. */
  analyticsExport: protectedProcedure
    .input(
      z.object({
        from: z.number().int().positive().optional(),
        to: z.number().int().positive().optional(),
        section: z.enum(VALID_CSV_SECTIONS),
      }),
    )
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getAnalyticsStore } = deps();
      if (!getAnalyticsStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Analytics not initialized" });
      }
      return { csv: getAnalyticsStore().exportCsv(resolveRange(input), input.section) };
    }),

  // -------------------------------------------------------------------------
  // Tenant God View (WOP-411)
  // -------------------------------------------------------------------------

  /** Get full tenant detail (god view). Aggregates user info, credits, status, usage. */
  tenantDetail: protectedProcedure.input(z.object({ tenantId: tenantIdSchema })).query(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getUserStore, getCreditStore, getTenantStatusStore, getMeterAggregator } = deps();

    const user = getUserStore().getById(input.tenantId);
    const balance = getCreditStore().getBalance(input.tenantId);
    const recentTransactions = getCreditStore().listTransactions(input.tenantId, { limit: 10 });
    const status = getTenantStatusStore().get(input.tenantId);

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const usageSummaries = getMeterAggregator
      ? getMeterAggregator().querySummaries(input.tenantId, { since: thirtyDaysAgo, limit: 1000 })
      : [];
    const usageTotal = getMeterAggregator
      ? getMeterAggregator().getTenantTotal(input.tenantId, thirtyDaysAgo)
      : { totalCost: 0, totalCharge: 0, eventCount: 0 };

    return {
      user: user ?? null,
      credits: { balance_cents: balance, recent_transactions: recentTransactions },
      status: status ?? { tenantId: input.tenantId, status: "active" },
      usage: { summaries: usageSummaries, total: usageTotal },
    };
  }),

  /** List bot instances for a tenant. */
  tenantAgents: protectedProcedure.input(z.object({ tenantId: tenantIdSchema })).query(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getBotBilling } = deps();
    if (!getBotBilling) {
      return { agents: [] };
    }
    const agents = getBotBilling().listForTenant(input.tenantId);
    return { agents };
  }),

  /** List admin notes for a tenant. */
  tenantNotes: protectedProcedure
    .input(z.object({ tenantId: tenantIdSchema, limit: z.number().int().positive().max(250).optional() }))
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getNotesStore } = deps();
      if (!getNotesStore) {
        return { notes: [] };
      }
      return { notes: getNotesStore().listForTenant(input.tenantId, input.limit) };
    }),

  /** Add an admin note to a tenant. */
  tenantNoteAdd: protectedProcedure
    .input(z.object({ tenantId: tenantIdSchema, content: z.string().min(1).max(10000) }))
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getNotesStore, getAuditLog } = deps();
      if (!getNotesStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Notes store not initialized" });
      }
      const adminUserId = ctx.user?.id ?? "unknown";
      const note = getNotesStore().add(input.tenantId, adminUserId, input.content);

      getAuditLog().log({
        adminUser: adminUserId,
        action: "tenant.note_added",
        category: "support",
        targetTenant: input.tenantId,
        details: { noteId: note.id },
      });

      return note;
    }),

  /** Change a user's role. */
  tenantChangeRole: protectedProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        tenantId: tenantIdSchema,
        role: z.enum(VALID_ROLES),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getRoleStore, getAuditLog } = deps();
      if (!getRoleStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Role store not initialized" });
      }
      const adminUserId = ctx.user?.id ?? "unknown";
      getRoleStore().setRole(input.userId, input.tenantId, input.role, adminUserId);

      getAuditLog().log({
        adminUser: adminUserId,
        action: "tenant.role_changed",
        category: "roles",
        targetTenant: input.tenantId,
        targetUser: input.userId,
        details: { newRole: input.role },
      });

      return { ok: true, role: input.role };
    }),

  /** Get usage breakdown by capability for a tenant (for chart). */
  tenantUsageByCapability: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        days: z.number().int().positive().max(90).optional().default(30),
      }),
    )
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getMeterAggregator } = deps();
      if (!getMeterAggregator) {
        return { usage: [] };
      }
      const since = Date.now() - input.days * 24 * 60 * 60 * 1000;
      const summaries = getMeterAggregator().querySummaries(input.tenantId, { since, limit: 1000 });
      return { usage: summaries };
    }),

  /** Export credit transactions as CSV. */
  creditsTransactionsExport: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        type: z.enum(["grant", "refund", "correction"]).optional(),
        from: z.number().int().optional(),
        to: z.number().int().optional(),
      }),
    )
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getCreditStore } = deps();
      const { tenantId, ...filters } = input;
      const result = getCreditStore().listTransactions(tenantId, { ...filters, limit: 10000 });

      const header = "id,tenant,type,amount_cents,reason,admin_user,reference_ids,created_at";
      const csvEscape = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const lines = result.entries.map((r) =>
        [
          csvEscape(r.id),
          csvEscape(r.tenant),
          csvEscape(r.type),
          String(r.amount_cents),
          csvEscape(r.reason),
          csvEscape(r.admin_user),
          csvEscape(r.reference_ids ?? ""),
          String(r.created_at),
        ].join(","),
      );

      return { csv: [header, ...lines].join("\n") };
    }),

  // -------------------------------------------------------------------------
  // Bulk Operations (WOP-418)
  // -------------------------------------------------------------------------

  /** Get all tenant IDs matching current filters (for "select all matching"). */
  bulkSelectAll: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        status: z.enum(VALID_STATUSES).optional(),
        role: z.enum(VALID_ROLES).optional(),
        hasCredits: z.boolean().optional(),
        lowBalance: z.boolean().optional(),
      }),
    )
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getBulkStore } = deps();
      if (!getBulkStore) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Bulk store not initialized" });
      return { tenantIds: getBulkStore().listMatchingTenantIds(input) };
    }),

  /** Dry-run: preview which tenants would be affected. */
  bulkDryRun: protectedProcedure
    .input(z.object({ tenantIds: z.array(tenantIdSchema).min(1).max(500) }))
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getBulkStore } = deps();
      if (!getBulkStore) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Bulk store not initialized" });
      return { tenants: getBulkStore().dryRun(input.tenantIds) };
    }),

  /** Mass grant credits. */
  bulkGrant: protectedProcedure
    .input(
      z.object({
        tenantIds: z.array(tenantIdSchema).min(1).max(500),
        amountCents: z.number().int().positive().max(100_000_00),
        reason: z.string().min(1).max(1000),
        notifyByEmail: z.boolean().default(false),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getBulkStore } = deps();
      if (!getBulkStore) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Bulk store not initialized" });
      return getBulkStore().bulkGrant(input, ctx.user?.id ?? "unknown");
    }),

  /** Undo a mass grant within 5 minutes. */
  bulkGrantUndo: protectedProcedure.input(z.object({ operationId: z.string().uuid() })).mutation(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getBulkStore } = deps();
    if (!getBulkStore) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Bulk store not initialized" });
    return getBulkStore().undoGrant(input.operationId, ctx.user?.id ?? "unknown");
  }),

  /** Mass suspend tenants. */
  bulkSuspend: protectedProcedure
    .input(
      z.object({
        tenantIds: z.array(tenantIdSchema).min(1).max(500),
        reason: z.string().min(1).max(1000),
        notifyByEmail: z.boolean().default(false),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getBulkStore } = deps();
      if (!getBulkStore) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Bulk store not initialized" });
      return getBulkStore().bulkSuspend(input, ctx.user?.id ?? "unknown");
    }),

  /** Mass reactivate tenants. */
  bulkReactivate: protectedProcedure
    .input(z.object({ tenantIds: z.array(tenantIdSchema).min(1).max(500) }))
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getBulkStore } = deps();
      if (!getBulkStore) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Bulk store not initialized" });
      return getBulkStore().bulkReactivate(input, ctx.user?.id ?? "unknown");
    }),

  /** Mass export to CSV. */
  bulkExport: protectedProcedure
    .input(
      z.object({
        tenantIds: z.array(tenantIdSchema).min(1).max(500),
        fields: z.array(
          z.object({
            key: z.enum([
              "account_info",
              "credit_balance",
              "monthly_products",
              "lifetime_spend",
              "last_seen",
              "transaction_history",
            ]),
            enabled: z.boolean(),
          }),
        ),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getBulkStore } = deps();
      if (!getBulkStore) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Bulk store not initialized" });
      return getBulkStore().bulkExport(input, ctx.user?.id ?? "unknown");
    }),
});
