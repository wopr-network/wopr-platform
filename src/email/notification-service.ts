/**
 * NotificationService — facade for enqueueing all system notifications.
 *
 * All callers go through this service rather than the queue store directly.
 * Resolves URLs and template data shapes so callers only need domain concepts.
 */

import type { NotificationQueueStore } from "./notification-queue-store.js";

export class NotificationService {
  constructor(
    private readonly queue: NotificationQueueStore,
    private readonly appBaseUrl: string,
  ) {}

  private creditsUrl(): string {
    return `${this.appBaseUrl}/billing/credits`;
  }

  // ---------------------------------------------------------------------------
  // Credit & Billing
  // ---------------------------------------------------------------------------

  notifyLowBalance(tenantId: string, email: string, balanceDollars: string, estimatedDays: number): void {
    this.queue.enqueue(tenantId, "low-balance", {
      email,
      balanceDollars,
      estimatedDaysRemaining: estimatedDays,
      creditsUrl: this.creditsUrl(),
    });
  }

  notifyCreditsDepeleted(tenantId: string, email: string): void {
    this.queue.enqueue(tenantId, "credits-depleted", {
      email,
      creditsUrl: this.creditsUrl(),
    });
  }

  notifyGracePeriodStart(tenantId: string, email: string, balanceDollars: string, graceDays: number): void {
    this.queue.enqueue(tenantId, "grace-period-start", {
      email,
      balanceDollars,
      graceDays,
      creditsUrl: this.creditsUrl(),
    });
  }

  notifyGracePeriodWarning(tenantId: string, email: string): void {
    this.queue.enqueue(tenantId, "grace-period-warning", {
      email,
      creditsUrl: this.creditsUrl(),
    });
  }

  notifyAutoSuspended(tenantId: string, email: string, reason: string): void {
    this.queue.enqueue(tenantId, "auto-suspended", {
      email,
      reason,
      creditsUrl: this.creditsUrl(),
    });
  }

  notifyAutoTopUpSuccess(tenantId: string, email: string, amountDollars: string, newBalanceDollars: string): void {
    this.queue.enqueue(tenantId, "auto-topup-success", {
      email,
      amountDollars,
      newBalanceDollars,
      creditsUrl: this.creditsUrl(),
    });
  }

  notifyAutoTopUpFailed(tenantId: string, email: string): void {
    this.queue.enqueue(tenantId, "auto-topup-failed", {
      email,
      creditsUrl: this.creditsUrl(),
    });
  }

  notifyCreditPurchaseReceipt(tenantId: string, email: string, amountDollars: string, newBalanceDollars: string): void {
    this.queue.enqueue(tenantId, "credit-purchase-receipt", {
      email,
      amountDollars,
      newBalanceDollars,
      creditsUrl: this.creditsUrl(),
    });
  }

  notifyCryptoPaymentConfirmed(
    tenantId: string,
    email: string,
    amountDollars: string,
    newBalanceDollars: string,
  ): void {
    this.queue.enqueue(tenantId, "crypto-payment-confirmed", {
      email,
      amountDollars,
      newBalanceDollars,
    });
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------

  notifyAdminSuspended(tenantId: string, email: string, reason: string): void {
    this.queue.enqueue(tenantId, "admin-suspended", { email, reason });
  }

  notifyAdminReactivated(tenantId: string, email: string): void {
    this.queue.enqueue(tenantId, "admin-reactivated", { email });
  }

  notifyCreditsGranted(tenantId: string, email: string, amountDollars: string, reason: string): void {
    this.queue.enqueue(tenantId, "credits-granted", { email, amountDollars, reason });
  }

  notifyRoleChanged(tenantId: string, email: string, newRole: string): void {
    this.queue.enqueue(tenantId, "role-changed", { email, newRole });
  }

  notifyTeamInvite(tenantId: string, email: string, tenantName: string, inviteUrl: string): void {
    this.queue.enqueue(tenantId, "team-invite", { email, tenantName, inviteUrl });
  }

  // ---------------------------------------------------------------------------
  // Agent & Channel
  // ---------------------------------------------------------------------------

  notifyAgentCreated(tenantId: string, email: string, agentName: string): void {
    this.queue.enqueue(tenantId, "agent-created", { email, agentName });
  }

  notifyChannelConnected(tenantId: string, email: string, channelName: string, agentName: string): void {
    this.queue.enqueue(tenantId, "channel-connected", { email, channelName, agentName });
  }

  notifyChannelDisconnected(
    tenantId: string,
    email: string,
    channelName: string,
    agentName: string,
    reason: string,
  ): void {
    this.queue.enqueue(tenantId, "channel-disconnected", { email, channelName, agentName, reason });
  }

  notifyAgentSuspended(tenantId: string, email: string, agentName: string, reason: string): void {
    this.queue.enqueue(tenantId, "agent-suspended", { email, agentName, reason });
  }

  // ---------------------------------------------------------------------------
  // Account Deletion
  // ---------------------------------------------------------------------------

  notifyAccountDeletionRequested(tenantId: string, email: string, deleteAfterDate: string): void {
    this.queue.enqueue(tenantId, "account-deletion-requested", {
      email,
      deleteAfterDate,
      cancelUrl: `${this.appBaseUrl}/settings/account`,
    });
  }

  notifyAccountDeletionCancelled(tenantId: string, email: string): void {
    this.queue.enqueue(tenantId, "account-deletion-cancelled", { email });
  }

  notifyAccountDeletionCompleted(tenantId: string, email: string): void {
    this.queue.enqueue(tenantId, "account-deletion-completed", { email });
  }

  // ---------------------------------------------------------------------------
  // Admin custom email
  // ---------------------------------------------------------------------------

  sendCustomEmail(tenantId: string, email: string, subject: string, bodyText: string): void {
    this.queue.enqueue(tenantId, "custom", { email, subject, bodyText });
  }
}
