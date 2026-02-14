/**
 * tRPC admin router — audit log, tier management, overrides.
 *
 * Provides typed procedures for admin-level operations.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { AdminAuditLog } from "../../admin/audit-log.js";
import type { CreditAdjustmentStore } from "../../admin/credits/adjustment-store.js";
import type { AdminUserStore } from "../../admin/users/user-store.js";
import { protectedProcedure, router } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AdminRouterDeps {
  getAuditLog: () => AdminAuditLog;
  getCreditStore: () => CreditAdjustmentStore;
  getUserStore: () => AdminUserStore;
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
});
