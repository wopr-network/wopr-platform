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
import type { IAdminNotesRepository } from "../../admin/notes/admin-notes-repository.js";
import type { RateStore } from "../../admin/rates/rate-store.js";
import type { RoleStore } from "../../admin/roles/role-store.js";
import type { ITenantStatusRepository } from "../../admin/tenant-status/tenant-status-repository.js";
import type { AdminUserStore } from "../../admin/users/user-store.js";
import type { INotificationQueueStore } from "../../email/notification-queue-store.js";
import type { NotificationService } from "../../email/notification-service.js";
import type { ISessionUsageRepository } from "../../inference/session-usage-repository.js";
import { Credit } from "../../monetization/credit.js";
import type { BotBilling } from "../../monetization/credits/bot-billing.js";
import type { ICreditLedger } from "../../monetization/credits/credit-ledger.js";
import type { PaymentHealthStatus } from "../../monetization/incident/health-probe.js";
import type { MeterAggregator } from "../../monetization/metering/aggregator.js";
import type { AlertChecker } from "../../observability/alerts.js";
import type { MetricsCollector } from "../../observability/metrics.js";
import type { SystemResourceMonitor, SystemResourceSnapshot } from "../../observability/system-resources.js";
import { protectedProcedure, router } from "../init.js";
import { inferenceAdminRouter, setInferenceAdminDeps } from "./inference-admin.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AdminRouterDeps {
  getAuditLog: () => AdminAuditLog;
  getCreditLedger: () => ICreditLedger;
  getRateStore?: () => RateStore;
  getUserStore: () => AdminUserStore;
  getTenantStatusStore: () => ITenantStatusRepository;
  getBotBilling?: () => BotBilling;
  getAnalyticsStore?: () => AnalyticsStore;
  getNotesStore?: () => IAdminNotesRepository;
  getMeterAggregator?: () => MeterAggregator;
  getRoleStore?: () => RoleStore;
  getBulkStore?: () => BulkOperationsStore;
  getRestoreService?: () => import("../../backup/restore-service.js").RestoreService;
  getRestoreLogStore?: () => import("../../backup/restore-log-store.js").RestoreLogStore;
  getNotificationService?: () => NotificationService;
  getNotificationQueueStore?: () => INotificationQueueStore;
  getSessionUsageRepo?: () => ISessionUsageRepository;
  // Billing health deps (WOP-531)
  getMetricsCollector?: () => MetricsCollector;
  getAlertChecker?: () => AlertChecker;
  getSystemResourceMonitor?: () => SystemResourceMonitor;
  probePaymentHealth?: () => Promise<PaymentHealthStatus>;
  queryActiveBots?: () => number | Promise<number>;
  queryActiveTenantCount?: () => number | Promise<number>;
}

let _deps: AdminRouterDeps | null = null;

export function setAdminRouterDeps(deps: AdminRouterDeps): void {
  _deps = deps;
  if (deps.getSessionUsageRepo) {
    setInferenceAdminDeps({ getSessionUsageRepo: deps.getSessionUsageRepo });
  }
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
  "auto_topup",
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
  creditsBalance: protectedProcedure.input(z.object({ tenantId: tenantIdSchema })).query(async ({ input }) => {
    const { getCreditLedger } = deps();
    const balance = await getCreditLedger().balance(input.tenantId);
    return { tenant: input.tenantId, balance_cents: balance.toCents() };
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
    .mutation(async ({ input, ctx }) => {
      const { getCreditLedger, getAuditLog } = deps();
      const adminUser = ctx.user?.id ?? "unknown";
      try {
        const result = await getCreditLedger().credit(
          input.tenantId,
          Credit.fromCents(input.amount_cents),
          "signup_grant",
          input.reason,
        );
        getAuditLog().log({
          adminUser,
          action: "credits.grant",
          category: "credits",
          targetTenant: input.tenantId,
          details: { amount_cents: input.amount_cents, reason: input.reason },
          outcome: "success",
        });
        return result;
      } catch (err) {
        getAuditLog().log({
          adminUser,
          action: "credits.grant",
          category: "credits",
          targetTenant: input.tenantId,
          details: { amount_cents: input.amount_cents, reason: input.reason, error: String(err) },
          outcome: "failure",
        });
        throw err;
      }
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
    .mutation(async ({ input, ctx }) => {
      const { getCreditLedger, getAuditLog } = deps();
      const adminUser = ctx.user?.id ?? "unknown";
      try {
        const result = await getCreditLedger().debit(
          input.tenantId,
          Credit.fromCents(input.amount_cents),
          "refund",
          input.reason,
        );
        getAuditLog().log({
          adminUser,
          action: "credits.refund",
          category: "credits",
          targetTenant: input.tenantId,
          details: { amount_cents: input.amount_cents, reason: input.reason, reference_ids: input.reference_ids },
          outcome: "success",
        });
        return result;
      } catch (err) {
        getAuditLog().log({
          adminUser,
          action: "credits.refund",
          category: "credits",
          targetTenant: input.tenantId,
          details: {
            amount_cents: input.amount_cents,
            reason: input.reason,
            reference_ids: input.reference_ids,
            error: String(err),
          },
          outcome: "failure",
        });
        throw err;
      }
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
    .mutation(async ({ input, ctx }) => {
      const { getCreditLedger, getAuditLog } = deps();
      const adminUser = ctx.user?.id ?? "unknown";
      try {
        const result = await (input.amount_cents >= 0
          ? getCreditLedger().credit(input.tenantId, Credit.fromCents(input.amount_cents || 1), "promo", input.reason)
          : getCreditLedger().debit(
              input.tenantId,
              Credit.fromCents(Math.abs(input.amount_cents)),
              "correction",
              input.reason,
            ));
        getAuditLog().log({
          adminUser,
          action: "credits.correction",
          category: "credits",
          targetTenant: input.tenantId,
          details: { amount_cents: input.amount_cents, reason: input.reason },
          outcome: "success",
        });
        return result;
      } catch (err) {
        getAuditLog().log({
          adminUser,
          action: "credits.correction",
          category: "credits",
          targetTenant: input.tenantId,
          details: { amount_cents: input.amount_cents, reason: input.reason, error: String(err) },
          outcome: "failure",
        });
        throw err;
      }
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
    .query(async ({ input }) => {
      const { getCreditLedger } = deps();
      const { tenantId, ...filters } = input;
      const entries = await getCreditLedger().history(tenantId, filters);
      return { entries, total: entries.length };
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
  usersGet: protectedProcedure.input(z.object({ userId: z.string().min(1) })).query(async ({ input }) => {
    const { getUserStore } = deps();
    const user = await getUserStore().getById(input.userId);
    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    }
    return user;
  }),

  // -------------------------------------------------------------------------
  // Tenant Status Management (WOP-412)
  // -------------------------------------------------------------------------

  /** Get tenant account status. */
  tenantStatus: protectedProcedure.input(z.object({ tenantId: tenantIdSchema })).query(async ({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getTenantStatusStore } = deps();
    const row = await getTenantStatusStore().get(input.tenantId);
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
    .mutation(async ({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getTenantStatusStore, getAuditLog, getBotBilling } = deps();
      const store = getTenantStatusStore();
      const adminUserId = ctx.user?.id ?? "unknown";

      // Check current status
      const current = await store.getStatus(input.tenantId);
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
      await store.suspend(input.tenantId, input.reason, adminUserId);

      // Suspend all bots for this tenant
      let suspendedBots: string[] = [];
      if (getBotBilling) {
        suspendedBots = await getBotBilling().suspendAllForTenant(input.tenantId);
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
    .mutation(async ({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getTenantStatusStore, getAuditLog } = deps();
      const store = getTenantStatusStore();
      const adminUserId = ctx.user?.id ?? "unknown";

      // Check current status
      const current = await store.getStatus(input.tenantId);
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
      await store.reactivate(input.tenantId, adminUserId);

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
    .mutation(async ({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getTenantStatusStore, getAuditLog, getCreditLedger, getBotBilling } = deps();
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
      const current = await store.getStatus(input.tenantId);
      if (current === "banned") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Account is already banned",
        });
      }

      // Suspend all bots
      let suspendedBots: string[] = [];
      if (getBotBilling) {
        suspendedBots = await getBotBilling().suspendAllForTenant(input.tenantId);
      }

      // Auto-refund remaining credits
      let refundedCents = 0;
      const balance = await getCreditLedger().balance(input.tenantId);
      if (balance.greaterThan(Credit.ZERO)) {
        await getCreditLedger().debit(input.tenantId, balance, "refund", `Auto-refund on account ban: ${input.reason}`);
        refundedCents = Math.round(balance.toCents());
      }

      // Ban the tenant
      await store.ban(input.tenantId, input.reason, adminUserId);

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
      const { getRateStore, getAuditLog } = deps();
      if (!getRateStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
      }
      const adminUser = ctx.user?.id ?? "unknown";
      try {
        const result = getRateStore().createSellRate(input);
        getAuditLog().log({
          adminUser,
          action: "rates.sell.create",
          category: "config",
          details: { ...input },
          outcome: "success",
        });
        return result;
      } catch (err) {
        getAuditLog().log({
          adminUser,
          action: "rates.sell.create",
          category: "config",
          details: { ...input, error: String(err) },
          outcome: "failure",
        });
        throw err;
      }
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
      const { getRateStore, getAuditLog } = deps();
      if (!getRateStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
      }
      const adminUser = ctx.user?.id ?? "unknown";
      const { id, ...updates } = input;
      try {
        const result = getRateStore().updateSellRate(id, updates);
        getAuditLog().log({
          adminUser,
          action: "rates.sell.update",
          category: "config",
          details: { id, ...updates },
          outcome: "success",
        });
        return result;
      } catch (err) {
        getAuditLog().log({
          adminUser,
          action: "rates.sell.update",
          category: "config",
          details: { id, ...updates, error: String(err) },
          outcome: "failure",
        });
        throw err;
      }
    }),

  /** Delete a sell rate. */
  ratesDeleteSell: protectedProcedure.input(z.object({ id: z.string().min(1) })).mutation(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getRateStore, getAuditLog } = deps();
    if (!getRateStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
    }
    const adminUser = ctx.user?.id ?? "unknown";
    try {
      const deleted = getRateStore().deleteSellRate(input.id);
      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Sell rate not found" });
      }
      getAuditLog().log({
        adminUser,
        action: "rates.sell.delete",
        category: "config",
        details: { id: input.id },
        outcome: "success",
      });
      return { success: true };
    } catch (err) {
      getAuditLog().log({
        adminUser,
        action: "rates.sell.delete",
        category: "config",
        details: { id: input.id, error: String(err) },
        outcome: "failure",
      });
      throw err;
    }
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
      const { getRateStore, getAuditLog } = deps();
      if (!getRateStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
      }
      const adminUser = ctx.user?.id ?? "unknown";
      try {
        const result = getRateStore().createProviderCost(input);
        getAuditLog().log({
          adminUser,
          action: "rates.provider.create",
          category: "config",
          details: { ...input },
          outcome: "success",
        });
        return result;
      } catch (err) {
        getAuditLog().log({
          adminUser,
          action: "rates.provider.create",
          category: "config",
          details: { ...input, error: String(err) },
          outcome: "failure",
        });
        throw err;
      }
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
      const { getRateStore, getAuditLog } = deps();
      if (!getRateStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
      }
      const adminUser = ctx.user?.id ?? "unknown";
      const { id, ...updates } = input;
      try {
        const result = getRateStore().updateProviderCost(id, updates);
        getAuditLog().log({
          adminUser,
          action: "rates.provider.update",
          category: "config",
          details: { id, ...updates },
          outcome: "success",
        });
        return result;
      } catch (err) {
        getAuditLog().log({
          adminUser,
          action: "rates.provider.update",
          category: "config",
          details: { id, ...updates, error: String(err) },
          outcome: "failure",
        });
        throw err;
      }
    }),

  /** Delete a provider cost. */
  ratesDeleteProvider: protectedProcedure.input(z.object({ id: z.string().min(1) })).mutation(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getRateStore, getAuditLog } = deps();
    if (!getRateStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Rate store not initialized" });
    }
    const adminUser = ctx.user?.id ?? "unknown";
    try {
      const deleted = getRateStore().deleteProviderCost(input.id);
      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Provider cost not found" });
      }
      getAuditLog().log({
        adminUser,
        action: "rates.provider.delete",
        category: "config",
        details: { id: input.id },
        outcome: "success",
      });
      return { success: true };
    } catch (err) {
      getAuditLog().log({
        adminUser,
        action: "rates.provider.delete",
        category: "config",
        details: { id: input.id, error: String(err) },
        outcome: "failure",
      });
      throw err;
    }
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

  /** Auto-topup metrics: event counts, revenue, failure rate. */
  analyticsAutoTopup: protectedProcedure.input(dateRangeSchema.partial()).query(({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getAnalyticsStore } = deps();
    if (!getAnalyticsStore) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Analytics not initialized" });
    }
    return getAnalyticsStore().getAutoTopupMetrics(resolveRange(input));
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
  tenantDetail: protectedProcedure.input(z.object({ tenantId: tenantIdSchema })).query(async ({ input, ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const { getUserStore, getCreditLedger, getTenantStatusStore, getMeterAggregator } = deps();

    const user = getUserStore().getById(input.tenantId);
    const balance = await getCreditLedger().balance(input.tenantId);
    const recentTransactions = await getCreditLedger().history(input.tenantId, { limit: 10 });
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
      credits: { balance_cents: balance.toCents(), recent_transactions: recentTransactions },
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

  // Admin Notes (WOP-409)
  // -------------------------------------------------------------------------

  /** List notes for a tenant. */
  notesList: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        limit: z.number().int().positive().max(250).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getNotesStore } = deps();
      if (!getNotesStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Notes store not initialized" });
      }
      return getNotesStore().list(input);
    }),

  /** Create a note on a tenant. */
  notesCreate: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        content: z.string().min(1).max(10000),
        isPinned: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getNotesStore, getAuditLog } = deps();
      if (!getNotesStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Notes store not initialized" });
      }
      const note = await getNotesStore().create({
        tenantId: input.tenantId,
        authorId: ctx.user?.id ?? "unknown",
        content: input.content,
        isPinned: input.isPinned,
      });
      void getAuditLog().log({
        adminUser: ctx.user?.id ?? "unknown",
        action: "note.create",
        category: "support",
        targetTenant: input.tenantId,
        details: { noteId: note.id },
      });
      return note;
    }),

  /** Update a note. */
  notesUpdate: protectedProcedure
    .input(
      z.object({
        noteId: z.string().min(1),
        tenantId: tenantIdSchema,
        content: z.string().min(1).max(10000).optional(),
        isPinned: z.boolean().optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getNotesStore, getAuditLog } = deps();
      if (!getNotesStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Notes store not initialized" });
      }
      const adminUser = ctx.user?.id ?? "unknown";
      const { noteId, tenantId, ...updates } = input;
      try {
        const note = getNotesStore().update(noteId, tenantId, updates);
        if (!note) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
        }
        getAuditLog().log({
          adminUser,
          action: "note.update",
          category: "support",
          targetTenant: tenantId,
          details: { noteId, hasContentChange: !!updates.content, hasPinChange: updates.isPinned !== undefined },
          outcome: "success",
        });
        return note;
      } catch (err) {
        getAuditLog().log({
          adminUser,
          action: "note.update",
          category: "support",
          targetTenant: tenantId,
          details: { noteId, error: String(err) },
          outcome: "failure",
        });
        throw err;
      }
    }),

  /** Delete a note. */
  notesDelete: protectedProcedure
    .input(z.object({ noteId: z.string().min(1), tenantId: tenantIdSchema }))
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getNotesStore, getAuditLog } = deps();
      if (!getNotesStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Notes store not initialized" });
      }
      const adminUser = ctx.user?.id ?? "unknown";
      try {
        const deleted = getNotesStore().delete(input.noteId, input.tenantId);
        if (!deleted) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Forbidden" });
        }
        getAuditLog().log({
          adminUser,
          action: "note.delete",
          category: "support",
          targetTenant: input.tenantId,
          details: { noteId: input.noteId },
          outcome: "success",
        });
        return { success: true };
      } catch (err) {
        getAuditLog().log({
          adminUser,
          action: "note.delete",
          category: "support",
          targetTenant: input.tenantId,
          details: { noteId: input.noteId, error: String(err) },
          outcome: "failure",
        });
        throw err;
      }
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
    .query(async ({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getCreditLedger } = deps();
      const { tenantId, ...filters } = input;
      const entries = await getCreditLedger().history(tenantId, { ...filters, limit: 10000 });

      const header = "id,tenantId,type,amountCents,description,referenceId,createdAt";
      const csvEscape = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const lines = entries.map((r) =>
        [
          csvEscape(r.id),
          csvEscape(r.tenantId),
          csvEscape(r.type),
          String(r.amount),
          csvEscape(r.description ?? ""),
          csvEscape(r.referenceId ?? ""),
          csvEscape(r.createdAt),
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
    .query(async ({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getBulkStore } = deps();
      if (!getBulkStore) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Bulk store not initialized" });
      return { tenantIds: await getBulkStore().listMatchingTenantIds(input) };
    }),

  /** Dry-run: preview which tenants would be affected. */
  bulkDryRun: protectedProcedure
    .input(z.object({ tenantIds: z.array(tenantIdSchema).min(1).max(500) }))
    .query(async ({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getBulkStore } = deps();
      if (!getBulkStore) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Bulk store not initialized" });
      return { tenants: await getBulkStore().dryRun(input.tenantIds) };
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
        snapshotKey: z
          .string()
          .regex(
            /^(nightly|latest)\/[a-zA-Z0-9._/-]+$/,
            "snapshotKey must begin with 'nightly/' or 'latest/' and contain only safe path characters",
          ),
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

  // -------------------------------------------------------------------------
  // Notification Management (WOP-417)
  // -------------------------------------------------------------------------

  /** Send a specific notification template to a tenant (admin override). */
  notificationSend: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        template: z.string().min(1).max(100),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getNotificationQueueStore, getAuditLog } = deps();
      const queueStore = getNotificationQueueStore?.();
      if (!queueStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Notification queue not initialized" });
      }

      const id = queueStore.enqueue(input.tenantId, input.template, input.data ?? {});

      getAuditLog().log({
        adminUser: ctx.user?.id ?? "unknown",
        action: "notification.send",
        category: "support",
        targetTenant: input.tenantId,
        details: { template: input.template, notificationId: id },
      });

      return { notificationId: id };
    }),

  /** Send a custom email to a tenant. */
  notificationSendCustom: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        email: z.string().email(),
        subject: z.string().min(1).max(500),
        body: z.string().min(1).max(10000),
      }),
    )
    .mutation(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getNotificationService, getAuditLog } = deps();
      const service = getNotificationService?.();
      if (!service) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Notification service not initialized" });
      }

      service.sendCustomEmail(input.tenantId, input.email, input.subject, input.body);

      getAuditLog().log({
        adminUser: ctx.user?.id ?? "unknown",
        action: "notification.custom",
        category: "support",
        targetTenant: input.tenantId,
        details: { subject: input.subject },
      });

      return { success: true };
    }),

  /** List notifications sent to a tenant (admin view). */
  notificationLog: protectedProcedure
    .input(
      z.object({
        tenantId: tenantIdSchema,
        status: z.enum(["pending", "sent", "failed"]).optional(),
        limit: z.number().int().positive().max(250).optional(),
        offset: z.number().int().min(0).optional(),
      }),
    )
    .query(({ input, ctx }) => {
      requirePlatformAdmin(ctx.user?.roles ?? []);
      const { getNotificationQueueStore } = deps();
      const queueStore = getNotificationQueueStore?.();
      if (!queueStore) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Notification queue not initialized" });
      }

      const { tenantId, ...opts } = input;
      return queueStore.listForTenant(tenantId, opts);
    }),

  /** Inference cost tracking and cache analytics. */
  inference: inferenceAdminRouter,

  /** Billing health dashboard — aggregates all observability signals. */
  billingHealth: protectedProcedure.query(async ({ ctx }) => {
    requirePlatformAdmin(ctx.user?.roles ?? []);
    const d = deps();
    const timestamp = Date.now();

    // Gateway metrics
    let gateway5m = {
      totalRequests: 0,
      totalErrors: 0,
      errorRate: 0,
      creditDeductionFailures: 0,
      byCapability: new Map<string, { requests: number; errors: number; errorRate: number }>(),
    };
    let gateway60m = { totalRequests: 0, totalErrors: 0, errorRate: 0 };
    if (d.getMetricsCollector) {
      try {
        const metrics = d.getMetricsCollector();
        const [w5, w60] = await Promise.all([metrics.getWindow(5), metrics.getWindow(60)]);
        gateway5m = w5;
        gateway60m = { totalRequests: w60.totalRequests, totalErrors: w60.totalErrors, errorRate: w60.errorRate };
      } catch {
        // Metrics unavailable — non-critical
      }
    }

    // Alerts
    let alerts: Array<{ name: string; firing: boolean; message: string }> = [];
    if (d.getAlertChecker) {
      try {
        alerts = d.getAlertChecker().getStatus();
      } catch {
        // Alert checker unavailable — non-critical
      }
    }

    // System resources
    let system: SystemResourceSnapshot | null = null;
    if (d.getSystemResourceMonitor) {
      try {
        system = d.getSystemResourceMonitor().getSnapshot();
      } catch {
        // Resource monitor unavailable — non-critical
      }
    }

    // Payment health (optional — needs Stripe client)
    let paymentChecks: PaymentHealthStatus["checks"] | null = null;
    let paymentOverall: "healthy" | "degraded" | "outage" = "healthy";
    let paymentSeverity: PaymentHealthStatus["severity"] = null;
    let paymentReasons: string[] = [];

    if (d.probePaymentHealth) {
      try {
        const health = await d.probePaymentHealth();
        paymentChecks = health.checks;
        paymentOverall = health.overall;
        paymentSeverity = health.severity;
        paymentReasons = health.reasons;
      } catch {
        paymentOverall = "degraded";
        paymentReasons = ["Payment health probe failed"];
      }
    }

    // Fleet
    let activeBots: number | null = null;
    if (d.queryActiveBots) {
      try {
        activeBots = await d.queryActiveBots();
      } catch {
        // DB unavailable — non-critical
      }
    }

    // Business metrics
    let activeTenantCount: number | null = null;
    if (d.queryActiveTenantCount) {
      try {
        activeTenantCount = await d.queryActiveTenantCount();
      } catch {
        // non-critical
      }
    }

    return {
      timestamp,
      gateway: {
        last5m: {
          totalRequests: gateway5m.totalRequests,
          totalErrors: gateway5m.totalErrors,
          errorRate: gateway5m.errorRate,
          byCapability: Object.fromEntries(gateway5m.byCapability),
        },
        last60m: {
          totalRequests: gateway60m.totalRequests,
          totalErrors: gateway60m.totalErrors,
          errorRate: gateway60m.errorRate,
        },
      },
      payment: {
        overall: paymentOverall,
        severity: paymentSeverity,
        reasons: paymentReasons,
        checks: paymentChecks,
      },
      alerts,
      system: system
        ? {
            cpuLoad1m: system.cpuLoad1m,
            cpuCount: system.cpuCount,
            memoryUsedBytes: system.memoryUsedBytes,
            memoryTotalBytes: system.memoryTotalBytes,
            diskUsedBytes: system.diskUsedBytes,
            diskTotalBytes: system.diskTotalBytes,
          }
        : null,
      fleet: { activeBots },
      business: {
        activeTenantCount,
      },
    };
  }),
});
