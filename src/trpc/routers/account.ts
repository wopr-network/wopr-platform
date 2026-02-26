/**
 * tRPC account router — account deletion and GDPR requests.
 *
 * Provides typed procedures for account deletion lifecycle:
 * request, status check, cancellation.
 *
 * Password re-authentication uses the `verifyPassword` dep injected at
 * startup so the router remains independently testable.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { AccountDeletionStore } from "../../account/deletion-store.js";
import type { NotificationService } from "../../email/notification-service.js";
import { router, tenantProcedure } from "../init.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AccountRouterDeps {
  getDeletionStore: () => AccountDeletionStore;
  getNotificationService?: () => NotificationService;
  /** Suspend all bots for the given tenant. */
  suspendBots?: (tenantId: string) => void;
  /** Suspend tenant status. */
  suspendTenant?: (tenantId: string, reason: string, actorId: string) => void;
  /** Reactivate a suspended tenant. */
  reactivateTenant?: (tenantId: string, actorId: string) => void;
  /** Resolve user email from userId. */
  getUserEmail: (userId: string) => string | null;
  /**
   * Verify the user's current password.
   * Returns true if valid, false or throws if invalid.
   */
  verifyPassword: (email: string, password: string) => Promise<boolean>;
}

let _deps: AccountRouterDeps | null = null;

export function setAccountRouterDeps(deps: AccountRouterDeps): void {
  _deps = deps;
}

function deps(): AccountRouterDeps {
  if (!_deps)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Account router not initialized",
    });
  return _deps;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const accountRouter = router({
  /**
   * Request account deletion.
   *
   * Requires re-authentication via password confirmation.
   * Queues a deletion request with 30-day grace period.
   * Immediately suspends all bots and marks tenant as pending deletion.
   * Sends confirmation email.
   */
  requestDeletion: tenantProcedure
    .input(
      z.object({
        /** User must type "DELETE MY ACCOUNT" to confirm. */
        confirmPhrase: z.literal("DELETE MY ACCOUNT"),
        /** Current password for re-authentication. */
        currentPassword: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { getDeletionStore, getNotificationService, suspendBots, suspendTenant, getUserEmail, verifyPassword } =
        deps();
      const store = getDeletionStore();
      const tenantId = ctx.tenantId;
      const userId = ctx.user.id;

      // Check for existing pending request
      const existing = await store.getPendingForTenant(tenantId);
      if (existing) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A deletion request is already pending for this account",
        });
      }

      // Re-authenticate: verify current password
      const email = getUserEmail(userId);
      if (!email) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Could not resolve user email for re-authentication",
        });
      }

      let verified: boolean;
      try {
        verified = await verifyPassword(email, input.currentPassword);
      } catch {
        verified = false;
      }

      if (!verified) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Password verification failed",
        });
      }

      // Create the deletion request
      const request = await store.create(tenantId, userId);

      // Suspend all bots immediately
      if (suspendBots) {
        suspendBots(tenantId);
      }

      // Mark tenant status as suspended with reason
      if (suspendTenant) {
        suspendTenant(tenantId, "Account deletion requested", userId);
      }

      // Send confirmation email
      if (email && getNotificationService) {
        getNotificationService().notifyAccountDeletionRequested(tenantId, email, request.deleteAfter);
      }

      return {
        requestId: request.id,
        deleteAfter: request.deleteAfter,
        status: "pending" as const,
      };
    }),

  /**
   * Get current deletion request status for the authenticated tenant.
   */
  deletionStatus: tenantProcedure.query(async ({ ctx }) => {
    const { getDeletionStore } = deps();
    const store = getDeletionStore();
    const request = await store.getPendingForTenant(ctx.tenantId);

    if (!request) {
      return { hasPendingDeletion: false as const };
    }

    return {
      hasPendingDeletion: true as const,
      requestId: request.id,
      deleteAfter: request.deleteAfter,
      createdAt: request.createdAt,
    };
  }),

  /**
   * Cancel a pending deletion request.
   * Only possible during the 30-day grace period.
   */
  cancelDeletion: tenantProcedure.input(z.object({ requestId: z.string().uuid() })).mutation(async ({ input, ctx }) => {
    const { getDeletionStore, getNotificationService, reactivateTenant, getUserEmail } = deps();
    const store = getDeletionStore();

    const request = await store.getById(input.requestId);
    if (!request || request.tenantId !== ctx.tenantId) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Deletion request not found",
      });
    }
    if (request.status !== "pending") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Deletion request is no longer pending",
      });
    }

    await store.cancel(input.requestId, `Cancelled by user ${ctx.user.id}`);

    // Reactivate the tenant
    if (reactivateTenant) {
      reactivateTenant(ctx.tenantId, ctx.user.id);
    }

    // Send cancellation email
    const email = getUserEmail(ctx.user.id);
    if (email && getNotificationService) {
      getNotificationService().notifyAccountDeletionCancelled(ctx.tenantId, email);
    }

    return { cancelled: true as const };
  }),
});
