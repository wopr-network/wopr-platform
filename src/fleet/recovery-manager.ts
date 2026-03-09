import { randomUUID } from "node:crypto";
import { logger } from "../config/logger.js";
import type { AdminNotifier, RecoveryReport } from "./admin-notifier.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import type { IBotProfileRepository } from "./bot-profile-repository.js";
import type { NodeConnectionManager, TenantAssignment } from "./node-connection-manager.js";
import type { INodeRepository } from "./node-repository.js";
import { InvalidTransitionError } from "./node-state-machine.js";
import type { IRecoveryRepository } from "./recovery-repository.js";
import type { RecoveryEvent, RecoveryItem, RecoveryItemStatus, TenantWithTier } from "./repository-types.js";

/** Max retry attempts per recovery item before marking as failed. */
const MAX_RETRY_ATTEMPTS = 5;

/** Max time (seconds) a recovery event can have waiting items before they're failed. 24h. */
const MAX_WAITING_DURATION_S = 24 * 60 * 60;

/**
 * Core recovery orchestrator — handles node failure recovery.
 *
 * Recovery flow:
 * 1. Mark dead node as "recovering"
 * 2. Get all tenants assigned to dead node
 * 3. Sort by tier priority (paid before free)
 * 4. For each tenant:
 *    a. Find best target node (most free capacity)
 *    b. Download hot backup on target node
 *    c. Import and start container on target node
 *    d. Verify running
 *    e. Update routing (reassign tenant to new node)
 * 5. Mark dead node as "offline"
 * 6. Notify admin
 */
export class RecoveryManager {
  private readonly recoveryRepo: IRecoveryRepository;
  private readonly botInstanceRepo: IBotInstanceRepository;
  private readonly botProfileRepo: IBotProfileRepository;
  private readonly nodeRepo: INodeRepository;
  private readonly nodeConnections: NodeConnectionManager;
  private readonly notifier: AdminNotifier;

  constructor(
    recoveryRepo: IRecoveryRepository,
    botInstanceRepo: IBotInstanceRepository,
    botProfileRepo: IBotProfileRepository,
    nodeRepo: INodeRepository,
    nodeConnections: NodeConnectionManager,
    notifier: AdminNotifier,
  ) {
    this.recoveryRepo = recoveryRepo;
    this.botInstanceRepo = botInstanceRepo;
    this.botProfileRepo = botProfileRepo;
    this.nodeRepo = nodeRepo;
    this.nodeConnections = nodeConnections;
    this.notifier = notifier;
  }

  /**
   * Get tenants assigned to a node with tier priority sorting
   * Priority: enterprise > pro > starter > free
   */
  private async getTenantsWithTierPriority(nodeId: string): Promise<TenantAssignment[]> {
    const tenants: TenantWithTier[] = await this.botInstanceRepo.listByNodeWithTier(nodeId);
    return tenants.map((t) => ({
      id: t.id,
      tenantId: t.tenantId,
      name: t.name,
      containerName: `tenant_${t.tenantId}`,
      estimatedMb: 100, // Default estimate; can be refined from heartbeat data
    }));
  }

  /**
   * Trigger recovery of all tenants on a dead node
   */
  async triggerRecovery(deadNodeId: string, trigger: "heartbeat_timeout" | "manual"): Promise<RecoveryReport> {
    const eventId = randomUUID();

    logger.info(`Starting recovery for node ${deadNodeId}`, { eventId, trigger });

    // 1. Transition node to "recovering" via state machine
    //    Guard: check current status to avoid invalid self-transitions (WOP-2006)
    const transitionReason = trigger === "heartbeat_timeout" ? "heartbeat_timeout" : "manual_recovery";
    const node = await this.nodeRepo.getById(deadNodeId);
    if (!node) {
      throw new Error(`Cannot start recovery: node ${deadNodeId} not found`);
    }

    try {
      if (node.status === "unhealthy") {
        await this.nodeRepo.transition(deadNodeId, "offline", transitionReason, "recovery_manager");
        await this.nodeRepo.transition(deadNodeId, "recovering", transitionReason, "recovery_manager");
      } else if (node.status === "offline") {
        await this.nodeRepo.transition(deadNodeId, "recovering", transitionReason, "recovery_manager");
      } else if (node.status !== "recovering") {
        // Node is in an unexpected state (active, provisioning, etc.) — cannot recover
        throw new InvalidTransitionError(node.status, "recovering");
      }
      // If already "recovering", skip transitions entirely (idempotent)
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        logger.error(`Cannot start recovery for node ${deadNodeId}: illegal state transition`, {
          eventId,
          err: err.message,
        });
      }
      throw err;
    }

    // 2. Get all tenants assigned to this node with tier priority
    const tenants = await this.getTenantsWithTierPriority(deadNodeId);

    // 3. Create recovery_events record
    await this.recoveryRepo.createEvent({
      id: eventId,
      nodeId: deadNodeId,
      trigger,
      tenantsTotal: tenants.length,
    });

    // 4. Attempt recovery for each tenant
    const report: RecoveryReport = {
      recovered: [],
      failed: [],
      skipped: [],
      waiting: [],
    };

    for (const tenant of tenants) {
      await this.recoverTenant(eventId, deadNodeId, tenant, report);
    }

    // 5. Transition node from "recovering" to "offline" via state machine
    await this.nodeRepo.transition(deadNodeId, "offline", "recovery_complete", "recovery_manager");

    // 6. Finalize recovery event
    const finalStatus = report.waiting.length > 0 ? "partial" : "completed";
    await this.recoveryRepo.updateEvent(eventId, {
      status: finalStatus as RecoveryEvent["status"],
      tenantsRecovered: report.recovered.length,
      tenantsFailed: report.failed.length,
      tenantsWaiting: report.waiting.length,
      completedAt: Math.floor(Date.now() / 1000),
      reportJson: JSON.stringify(report),
    });

    // 7. Notify admin
    await this.notifier.nodeRecoveryComplete(deadNodeId, report);

    if (report.waiting.length > 0) {
      await this.notifier.capacityOverflow(deadNodeId, report.waiting.length, tenants.length);
    }

    logger.info(`Recovery complete for node ${deadNodeId}`, {
      eventId,
      recovered: report.recovered.length,
      failed: report.failed.length,
      waiting: report.waiting.length,
    });

    return report;
  }

  /**
   * Recover a single tenant
   */
  private async recoverTenant(
    eventId: string,
    deadNodeId: string,
    tenant: TenantAssignment,
    report: RecoveryReport,
    retryCount = 0,
  ): Promise<void> {
    const itemId = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    logger.info(`Recovering tenant ${tenant.name} (${tenant.tenantId})`, { eventId, itemId });

    // a. Find best target node (most free capacity, status=active)
    const target = await this.nodeConnections.findBestTarget(deadNodeId, tenant.estimatedMb);

    if (!target) {
      logger.warn(`No capacity available for tenant ${tenant.name}`, { eventId, itemId });
      report.waiting.push({ tenant: tenant.id, reason: "no_capacity" });
      await this.recordItem(eventId, itemId, tenant, deadNodeId, null, "waiting", "no_capacity", now, retryCount);
      return;
    }

    try {
      // b. Download hot backup on target node
      const backupKey = `latest/${tenant.containerName}/latest.tar.gz`;
      logger.debug(`Downloading backup for ${tenant.name} to node ${target.id}`, { backupKey });

      await this.nodeConnections.sendCommand(target.id, {
        type: "backup.download",
        payload: { filename: backupKey },
      });

      // c. Import and start on target node — read image/env from bot profile
      logger.debug(`Importing ${tenant.name} on node ${target.id}`);

      let image = "ghcr.io/wopr-network/wopr:latest";
      let env: Record<string, string> = {};

      const profile = await this.botProfileRepo.get(tenant.id);
      if (profile) {
        image = profile.image;
        env = profile.env;
      } else {
        logger.warn(`No profile found for bot ${tenant.id} — using default image and empty env`, { eventId, itemId });
      }

      await this.nodeConnections.sendCommand(target.id, {
        type: "bot.import",
        payload: {
          name: tenant.containerName,
          image,
          env,
        },
      });

      // d. Verify running
      logger.debug(`Verifying ${tenant.name} is running on node ${target.id}`);

      await this.nodeConnections.sendCommand(target.id, {
        type: "bot.inspect",
        payload: { name: tenant.containerName },
      });

      // e. Update routing (reassign tenant to new node)
      await this.nodeConnections.reassignTenant(tenant.id, target.id);

      // f. Update target node used_mb
      await this.nodeConnections.addNodeCapacity(target.id, tenant.estimatedMb);

      logger.info(`Recovered tenant ${tenant.name} to node ${target.id}`, { eventId, itemId });
      report.recovered.push({ tenant: tenant.id, target: target.id });
      await this.recordItem(eventId, itemId, tenant, deadNodeId, target.id, "recovered", null, now, retryCount);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to recover tenant ${tenant.name}`, { eventId, itemId, err: reason });
      report.failed.push({ tenant: tenant.id, reason });
      await this.recordItem(eventId, itemId, tenant, deadNodeId, target?.id, "failed", reason, now, retryCount);
    }
  }

  /**
   * Record a recovery item in the database
   */
  private async recordItem(
    eventId: string,
    itemId: string,
    tenant: TenantAssignment,
    sourceNodeId: string,
    targetNodeId: string | null | undefined,
    status: string,
    reason: string | null,
    startedAt: number,
    retryCount = 0,
  ): Promise<void> {
    const backupKey = `latest/${tenant.containerName}/latest.tar.gz`;

    await this.recoveryRepo.createItem({
      id: itemId,
      recoveryEventId: eventId,
      tenant: tenant.tenantId,
      sourceNode: sourceNodeId,
      targetNode: targetNodeId ?? null,
      backupKey,
      status: status as RecoveryItemStatus,
      reason,
      retryCount,
      startedAt,
      completedAt: status !== "waiting" ? Math.floor(Date.now() / 1000) : null,
    });
  }

  /**
   * Retry recovery for waiting tenants (after new capacity added)
   */
  async retryWaiting(recoveryEventId: string): Promise<RecoveryReport> {
    const event = await this.recoveryRepo.getEvent(recoveryEventId);

    if (!event) {
      throw new Error(`Recovery event ${recoveryEventId} not found`);
    }

    // Get all waiting items
    const waitingItems = await this.recoveryRepo.getWaitingItems(recoveryEventId);

    logger.info(`Retrying ${waitingItems.length} waiting tenants for event ${recoveryEventId}`);

    const report: RecoveryReport = {
      recovered: [],
      failed: [],
      skipped: [],
      waiting: [],
    };

    for (const item of waitingItems) {
      // Look up the actual bot instance to get the correct ID
      const botInstance = await this.botInstanceRepo.findByTenantAndNode(item.tenant, item.sourceNode);

      if (!botInstance) {
        report.failed.push({ tenant: item.tenant, reason: "bot_instance_not_found" });
        continue;
      }

      const tenant: TenantAssignment = {
        id: botInstance.id,
        tenantId: item.tenant,
        name: botInstance.name,
        containerName: `tenant_${item.tenant}`,
        estimatedMb: 100,
      };

      await this.recoverTenant(recoveryEventId, event.nodeId, tenant, report, item.retryCount + 1);

      // Mark waiting item as processed
      await this.recoveryRepo.updateItem(item.id, {
        status: "retried" as RecoveryItem["status"],
        completedAt: Math.floor(Date.now() / 1000),
      });
      await this.recoveryRepo.incrementRetryCount(item.id);
    }

    // Update event with new counts
    await this.recoveryRepo.updateEvent(recoveryEventId, {
      tenantsRecovered: (event.tenantsRecovered ?? 0) + report.recovered.length,
      tenantsFailed: (event.tenantsFailed ?? 0) + report.failed.length,
      tenantsWaiting: report.waiting.length,
      status: (report.waiting.length > 0 ? "partial" : "completed") as RecoveryEvent["status"],
      completedAt: report.waiting.length === 0 ? Math.floor(Date.now() / 1000) : event.completedAt,
    });

    return report;
  }

  /**
   * Check all open recovery events for waiting items and either retry them
   * or mark them as failed if they've exceeded the retry/time cap.
   *
   * Called automatically when capacity may have changed (node registered, bot destroyed).
   */
  async checkAndRetryWaiting(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Find all events with status "in_progress" or "partial"
    const openEvents = await this.recoveryRepo.listOpenEvents();

    for (const event of openEvents) {
      try {
        // Get waiting items for this event
        const waitingItems = await this.recoveryRepo.getWaitingItems(event.id);

        if (waitingItems.length === 0) continue;

        // Check time cap: if event started > 24h ago, fail all waiting items
        const eventAge = now - event.startedAt;
        if (eventAge >= MAX_WAITING_DURATION_S) {
          await this.failExpiredWaitingItems(event.id, waitingItems, "max_wait_time_exceeded");
          continue;
        }

        // Check per-item retry cap: fail items that have hit MAX_RETRY_ATTEMPTS
        const expiredItems = waitingItems.filter((item) => item.retryCount >= MAX_RETRY_ATTEMPTS);
        const retryableItems = waitingItems.filter((item) => item.retryCount < MAX_RETRY_ATTEMPTS);

        if (expiredItems.length > 0) {
          await this.failExpiredWaitingItems(event.id, expiredItems, "max_retries_exceeded");
        }

        // If there are still retryable items, call retryWaiting
        if (retryableItems.length > 0) {
          await this.retryWaiting(event.id);
        }

        // After retry, check if event is now fully resolved
        await this.finalizeEventIfComplete(event.id);
      } catch (err) {
        logger.error(`Auto-retry check failed for event ${event.id}`, {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Mark waiting items as "failed" and notify admin.
   */
  private async failExpiredWaitingItems(
    eventId: string,
    items: Array<{ id: string; tenant: string; retryCount: number }>,
    reason: string,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    for (const item of items) {
      await this.recoveryRepo.updateItem(item.id, {
        status: "failed" as RecoveryItem["status"],
        reason,
        completedAt: now,
      });
    }

    // Update event failed count and recalculate waiting count
    const event = await this.recoveryRepo.getEvent(eventId);
    if (event) {
      const remainingWaiting = await this.recoveryRepo.getWaitingItems(eventId);

      await this.recoveryRepo.updateEvent(eventId, {
        tenantsFailed: (event.tenantsFailed ?? 0) + items.length,
        tenantsWaiting: remainingWaiting.length,
        status: (remainingWaiting.length > 0 ? "partial" : "completed") as RecoveryEvent["status"],
        completedAt: remainingWaiting.length === 0 ? now : event.completedAt,
      });
    }

    await this.notifier.waitingTenantsExpired(eventId, items.length, reason);

    logger.warn(`Marked ${items.length} waiting items as failed for event ${eventId}`, { reason });
  }

  /**
   * Check if all items in an event are resolved and mark event as "completed" if so.
   */
  private async finalizeEventIfComplete(eventId: string): Promise<void> {
    const remainingWaiting = await this.recoveryRepo.getWaitingItems(eventId);

    if (remainingWaiting.length === 0) {
      const event = await this.recoveryRepo.getEvent(eventId);
      if (event && event.status !== "completed") {
        await this.recoveryRepo.updateEvent(eventId, {
          status: "completed",
          tenantsWaiting: 0,
          completedAt: Math.floor(Date.now() / 1000),
        });
      }
    }
  }

  /**
   * Get recovery event history
   */
  async listEvents(limit = 50): Promise<RecoveryEvent[]> {
    return this.recoveryRepo.listEvents(limit);
  }

  /**
   * Get recovery items for a specific event
   */
  async getEventDetails(eventId: string): Promise<{ event: RecoveryEvent | undefined; items: RecoveryItem[] }> {
    const event = await this.recoveryRepo.getEvent(eventId);
    const items = await this.recoveryRepo.listItemsByEvent(eventId);

    return {
      event: event ?? undefined,
      items,
    };
  }
}
