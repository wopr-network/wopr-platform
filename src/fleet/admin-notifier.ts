import { logger } from "../config/logger.js";

/** Recovery report from RecoveryManager */
export interface RecoveryReport {
  recovered: Array<{ tenant: string; target: string }>;
  failed: Array<{ tenant: string; reason: string }>;
  skipped: Array<{ tenant: string; reason: string }>;
  waiting: Array<{ tenant: string; reason: string }>;
}

/**
 * Admin notification service for node failure and recovery events.
 *
 * For MVP, this writes to the logger and optionally sends webhooks.
 * Future enhancements: email, Slack, PagerDuty integration.
 */
export class AdminNotifier {
  private readonly webhookUrl?: string;

  constructor(options: { webhookUrl?: string } = {}) {
    this.webhookUrl = options.webhookUrl;
  }

  /**
   * Notify admin that node recovery is complete
   */
  async nodeRecoveryComplete(nodeId: string, report: RecoveryReport): Promise<void> {
    const totalTenants = report.recovered.length + report.failed.length + report.skipped.length + report.waiting.length;

    const message = [
      `🔴 Node Failure — Auto-Recovery Complete`,
      `Node: ${nodeId}`,
      `Status: OFFLINE`,
      ``,
      `Recovery Summary:`,
      `  ✅ ${report.recovered.length} bots restored`,
      `  ❌ ${report.failed.length} failed`,
      `  ⏭️  ${report.skipped.length} skipped`,
      `  ⏳ ${report.waiting.length} waiting for capacity`,
      ``,
      `Total: ${totalTenants} tenants`,
    ].join("\n");

    logger.info(message);

    if (this.webhookUrl) {
      await this.sendWebhook({
        type: "node_recovery_complete",
        node_id: nodeId,
        report,
      });
    }
  }

  /**
   * Notify admin that a node status changed
   */
  async nodeStatusChange(nodeId: string, newStatus: string): Promise<void> {
    const message = `Node ${nodeId} status changed to ${newStatus}`;
    logger.info(message);

    if (this.webhookUrl) {
      await this.sendWebhook({
        type: "node_status_change",
        node_id: nodeId,
        status: newStatus,
      });
    }
  }

  /**
   * Notify admin that there is not enough capacity to recover all tenants
   */
  async capacityOverflow(nodeId: string, waiting: number, total: number): Promise<void> {
    const message = [
      `🟡 Capacity Overflow`,
      `Node: ${nodeId}`,
      `${waiting}/${total} tenants waiting for capacity`,
      `Action required: provision additional nodes`,
    ].join("\n");

    logger.warn(message);

    if (this.webhookUrl) {
      await this.sendWebhook({
        type: "capacity_overflow",
        node_id: nodeId,
        waiting,
        total,
      });
    }
  }

  /**
   * Notify admin that waiting tenants have exceeded retry/time limits
   */
  async waitingTenantsExpired(eventId: string, failedCount: number, reason: string): Promise<void> {
    const message = [
      `Recovery Timeout`,
      `Event: ${eventId}`,
      `${failedCount} waiting tenant(s) marked as failed`,
      `Reason: ${reason}`,
      `Action required: investigate and manually recover if needed`,
    ].join("\n");

    logger.warn(message);

    if (this.webhookUrl) {
      await this.sendWebhook({
        type: "waiting_tenants_expired",
        event_id: eventId,
        failed_count: failedCount,
        reason,
      });
    }
  }

  /**
   * Send a webhook notification
   */
  private async sendWebhook(payload: Record<string, unknown>): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        logger.error(`Webhook failed: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      logger.error("Webhook error", { err });
    }
  }
}
