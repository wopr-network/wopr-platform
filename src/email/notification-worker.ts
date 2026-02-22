/**
 * NotificationWorker — processes pending notification queue entries.
 *
 * Called on a timer (e.g. every 30s) from the server startup code.
 * Do NOT put the interval inside this class.
 */

import { logger } from "../config/logger.js";
import type { EmailClient } from "./client.js";
import type { INotificationPreferencesStore } from "./notification-preferences-store.js";
import type { INotificationQueueStore } from "./notification-queue-store.js";
import { renderNotificationTemplate, type TemplateName } from "./notification-templates.js";

export interface NotificationWorkerConfig {
  queue: INotificationQueueStore;
  emailClient: EmailClient;
  preferences: INotificationPreferencesStore;
  batchSize?: number;
}

/** Templates that bypass user preference checks — always sent. */
const CRITICAL_TEMPLATES: Set<string> = new Set([
  "grace-period-start",
  "grace-period-warning",
  "auto-suspended",
  "admin-suspended",
  "admin-reactivated",
  "password-reset",
  "welcome",
  "account-deletion-requested",
  "account-deletion-cancelled",
  "account-deletion-completed",
]);

/** Map from template name to preference key. */
const PREF_MAP: Record<string, string> = {
  "low-balance": "billing_low_balance",
  "credits-depleted": "billing_low_balance",
  "auto-topup-success": "billing_auto_topup",
  "auto-topup-failed": "billing_auto_topup",
  "credit-purchase-receipt": "billing_receipts",
  "crypto-payment-confirmed": "billing_receipts",
  "channel-disconnected": "agent_channel_disconnect",
  "agent-created": "agent_status_changes",
  "channel-connected": "agent_status_changes",
  "agent-suspended": "agent_status_changes",
  "credits-granted": "billing_receipts",
  "role-changed": "account_role_changes",
  "team-invite": "account_team_invites",
};

export class NotificationWorker {
  private readonly queue: INotificationQueueStore;
  private readonly emailClient: EmailClient;
  private readonly preferences: INotificationPreferencesStore;
  private readonly batchSize: number;

  constructor(config: NotificationWorkerConfig) {
    this.queue = config.queue;
    this.emailClient = config.emailClient;
    this.preferences = config.preferences;
    this.batchSize = config.batchSize ?? 10;
  }

  /** Process one batch of pending notifications. Returns count of processed items. */
  async processBatch(): Promise<number> {
    const pending = this.queue.fetchPending(this.batchSize);
    let processed = 0;

    for (const notif of pending) {
      try {
        const data = JSON.parse(notif.data) as Record<string, unknown>;
        const email = data.email as string | undefined;

        if (!email) {
          logger.error("Notification missing email field", {
            notificationId: notif.id,
            template: notif.template,
          });
          this.queue.markFailed(notif.id, notif.attempts + 1);
          processed++;
          continue;
        }

        // Check preferences (skip for critical notifications)
        if (!CRITICAL_TEMPLATES.has(notif.template)) {
          const prefs = this.preferences.get(notif.tenantId);
          if (!this.isEnabledByPreferences(notif.template, prefs as unknown as Record<string, boolean>)) {
            // User has disabled this notification type — mark sent to clear queue
            this.queue.markSent(notif.id);
            processed++;
            continue;
          }
        }

        // Render the template
        const rendered = renderNotificationTemplate(notif.template as TemplateName, data);

        // Send via email client
        await this.emailClient.send({
          to: email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          userId: notif.tenantId,
          templateName: notif.template,
        });

        this.queue.markSent(notif.id);
        processed++;
      } catch (err) {
        logger.error("Notification send failed", {
          notificationId: notif.id,
          template: notif.template,
          error: err instanceof Error ? err.message : String(err),
        });
        this.queue.markFailed(notif.id, notif.attempts + 1);
        processed++;
      }
    }

    return processed;
  }

  private isEnabledByPreferences(template: string, prefs: Record<string, boolean>): boolean {
    const prefKey = PREF_MAP[template];
    if (!prefKey) return true; // unknown template -> send by default
    return prefs[prefKey] !== false; // default to enabled if key missing
  }
}
