/**
 * tRPC admin router — audit log, tier management, overrides, tenant status.
 *
 * Provides typed procedures for admin-level operations.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { AnalyticsStore } from "../../admin/analytics/analytics-store.js";
import type { AdminAuditLog } from "../../admin/audit-log.js";
import type { CreditAdjustmentStore } from "../../admin/credits/adjustment-store.js";
import type { RateStore } from "../../admin/rates/rate-store.js";
import type { TenantStatusStore } from "../../admin/tenant-status/tenant-status-store.js";
import type { AdminUserStore } from "../../admin/users/user-store.js";
import type { BotBilling } from "../../monetization/credits/bot-billing.js";
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
  getRestoreService?: () => import("../../backup/restore-service.js").RestoreService;
  getRestoreLogStore?: () => import("../../backup/restore-log-store.js").RestoreLogStore;
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
  // Backup Restore (WOP-439)
  // -------------------------------------------------------------------------

  /** List available snapshots for a tenant. */
  restoreListSnapshots: protectedProcedure
    .input(z.object({ tenantId: tenantIdSchema }))
    .query(async ({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getRestoreService } = deps();
      if (!getRestoreService) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Restore service not initialized" });
      }
      return { snapshots: await getRestoreService().listSnapshots(input.tenantId) };
    }),

  /** Trigger a restore from a snapshot. Destructive — requires confirmation. */
  restoreFromSnapshot: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        nodeId: z.string().min(1),
        snapshotKey: z.string().regex(/^(nightly|latest)\/[a-zA-Z0-9._/-]+$/, "snapshotKey must begin with 'nightly/' or 'latest/' and contain only safe path characters"),
        reason: z.string().min(1).max(1000).optional(),
        /** Must type "RESTORE {tenantId}" to confirm. */
        confirmRestore: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getRestoreService, getAuditLog } = deps();
      if (!getRestoreService) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Restore service not initialized" });
      }

      // Verify typed confirmation
      const expectedConfirmation = `RESTORE ${input.tenantId}`;
      if (input.confirmRestore !== expectedConfirmation) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Type "${expectedConfirmation}" to confirm the restore`,
        });
      }

      const adminUserId = ctx.user?.id ?? "unknown";
      const result = await getRestoreService().restore({
        tenantId: input.tenantId,
        nodeId: input.nodeId,
        snapshotKey: input.snapshotKey,
        restoredBy: adminUserId,
        reason: input.reason,
      });

      // Audit log
      getAuditLog().log({
        adminUser: adminUserId,
        action: "backup.restore",
        category: "config",
        targetTenant: input.tenantId,
        details: {
          snapshotKey: input.snapshotKey,
          nodeId: input.nodeId,
          success: result.success,
          downtimeMs: result.downtimeMs,
          preRestoreKey: result.preRestoreKey,
          restoreLogId: result.restoreLogId,
          error: result.error,
          reason: input.reason,
        },
      });

      if (!result.success) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Restore failed: ${result.error}`,
        });
      }

      return result;
    }),

  /** List restore history for a tenant. */
  restoreHistory: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        limit: z.number().int().positive().max(250).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getRestoreLogStore } = deps();
      if (!getRestoreLogStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Restore log store not initialized" });
      }
      return { entries: getRestoreLogStore().listForTenant(input.tenantId, input.limit) };
    }),
});
