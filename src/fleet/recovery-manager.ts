import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { logger } from "../config/logger.js";
import type * as schema from "../db/schema/index.js";
import {
  botInstances,
  botProfiles,
  nodes,
  recoveryEvents,
  recoveryItems,
  tenantCustomers,
} from "../db/schema/index.js";
import type { AdminNotifier, RecoveryReport } from "./admin-notifier.js";
import type { NodeConnectionManager, TenantAssignment } from "./node-connection-manager.js";

/** Max retry attempts per recovery item before marking as failed. */
const MAX_RETRY_ATTEMPTS = 5;

/** Max time (seconds) a recovery event can have waiting items before they're failed. 24h. */
const MAX_WAITING_DURATION_S = 24 * 60 * 60;

/**
 * Recovery event record
 */
export interface RecoveryEvent {
  id: string;
  nodeId: string;
  trigger: string;
  status: string;
  tenantsTotal: number | null;
  tenantsRecovered: number | null;
  tenantsFailed: number | null;
  tenantsWaiting: number | null;
  startedAt: number;
  completedAt: number | null;
  reportJson: string | null;
}

/**
 * Recovery item record
 */
export interface RecoveryItem {
  id: string;
  recoveryEventId: string;
  tenant: string;
  sourceNode: string;
  targetNode: string | null;
  backupKey: string | null;
  status: string;
  reason: string | null;
  startedAt: number | null;
  completedAt: number | null;
  retryCount: number;
}

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
  private readonly db: BetterSQLite3Database<typeof schema>;
  private readonly nodeConnections: NodeConnectionManager;
  private readonly notifier: AdminNotifier;

  constructor(
    db: BetterSQLite3Database<typeof schema>,
    nodeConnections: NodeConnectionManager,
    notifier: AdminNotifier,
  ) {
    this.db = db;
    this.nodeConnections = nodeConnections;
    this.notifier = notifier;
  }

  /**
   * Get tenants assigned to a node with tier priority sorting
   * Priority: enterprise > pro > starter > free
   */
  private getTenantsWithTierPriority(nodeId: string): TenantAssignment[] {
    const instances = this.db
      .select({
        id: botInstances.id,
        tenantId: botInstances.tenantId,
        name: botInstances.name,
        tier: tenantCustomers.tier,
      })
      .from(botInstances)
      .leftJoin(tenantCustomers, eq(botInstances.tenantId, tenantCustomers.tenant))
      .where(eq(botInstances.nodeId, nodeId))
      .orderBy(
        sql`CASE ${tenantCustomers.tier}
          WHEN 'enterprise' THEN 1
          WHEN 'pro' THEN 2
          WHEN 'starter' THEN 3
          ELSE 4
        END`,
        botInstances.id,
      )
      .all();

    return instances.map((inst) => ({
      id: inst.id,
      tenantId: inst.tenantId,
      name: inst.name,
      containerName: `tenant_${inst.tenantId}`,
      estimatedMb: 100, // Default estimate; can be refined from heartbeat data
    }));
  }

  /**
   * Trigger recovery of all tenants on a dead node
   */
  async triggerRecovery(deadNodeId: string, trigger: "heartbeat_timeout" | "manual"): Promise<RecoveryReport> {
    const eventId = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    logger.info(`Starting recovery for node ${deadNodeId}`, { eventId, trigger });

    // 1. Mark node as "recovering"
    this.db.update(nodes).set({ status: "recovering" }).where(eq(nodes.id, deadNodeId)).run();

    // 2. Get all tenants assigned to this node with tier priority
    const tenants = this.getTenantsWithTierPriority(deadNodeId);

    // 3. Create recovery_events record
    this.db
      .insert(recoveryEvents)
      .values({
        id: eventId,
        nodeId: deadNodeId,
        trigger,
        status: "in_progress",
        tenantsTotal: tenants.length,
        tenantsRecovered: 0,
        tenantsFailed: 0,
        tenantsWaiting: 0,
        startedAt: now,
        completedAt: null,
        reportJson: null,
      })
      .run();

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

    // 5. Mark dead node as offline
    this.db.update(nodes).set({ status: "offline" }).where(eq(nodes.id, deadNodeId)).run();

    // 6. Finalize recovery event
    const finalStatus = report.waiting.length > 0 ? "partial" : "completed";
    this.db
      .update(recoveryEvents)
      .set({
        status: finalStatus,
        tenantsRecovered: report.recovered.length,
        tenantsFailed: report.failed.length,
        tenantsWaiting: report.waiting.length,
        completedAt: Math.floor(Date.now() / 1000),
        reportJson: JSON.stringify(report),
      })
      .where(eq(recoveryEvents.id, eventId))
      .run();

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
    const target = this.nodeConnections.findBestTarget(deadNodeId, tenant.estimatedMb);

    if (!target) {
      logger.warn(`No capacity available for tenant ${tenant.name}`, { eventId, itemId });
      report.waiting.push({ tenant: tenant.id, reason: "no_capacity" });
      this.recordItem(eventId, itemId, tenant, deadNodeId, null, "waiting", "no_capacity", now, retryCount);
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

      const profile = this.db
        .select({ image: botProfiles.image, env: botProfiles.env })
        .from(botProfiles)
        .where(eq(botProfiles.id, tenant.id))
        .get();

      if (profile) {
        image = profile.image;
        try {
          env = JSON.parse(profile.env);
        } catch {
          logger.warn(`Corrupt env JSON for bot ${tenant.id}, using empty env`, { eventId, itemId });
        }
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
      this.nodeConnections.reassignTenant(tenant.id, target.id);

      // f. Update target node used_mb
      this.nodeConnections.addNodeCapacity(target.id, tenant.estimatedMb);

      logger.info(`Recovered tenant ${tenant.name} to node ${target.id}`, { eventId, itemId });
      report.recovered.push({ tenant: tenant.id, target: target.id });
      this.recordItem(eventId, itemId, tenant, deadNodeId, target.id, "recovered", null, now, retryCount);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to recover tenant ${tenant.name}`, { eventId, itemId, err: reason });
      report.failed.push({ tenant: tenant.id, reason });
      this.recordItem(eventId, itemId, tenant, deadNodeId, target?.id, "failed", reason, now, retryCount);
    }
  }

  /**
   * Record a recovery item in the database
   */
  private recordItem(
    eventId: string,
    itemId: string,
    tenant: TenantAssignment,
    sourceNodeId: string,
    targetNodeId: string | null,
    status: string,
    reason: string | null,
    startedAt: number,
    retryCount = 0,
  ): void {
    const backupKey = `latest/${tenant.containerName}/latest.tar.gz`;

    this.db
      .insert(recoveryItems)
      .values({
        id: itemId,
        recoveryEventId: eventId,
        tenant: tenant.tenantId,
        sourceNode: sourceNodeId,
        targetNode: targetNodeId,
        backupKey,
        status,
        reason,
        retryCount,
        startedAt,
        completedAt: status !== "waiting" ? Math.floor(Date.now() / 1000) : null,
      })
      .run();
  }

  /**
   * Retry recovery for waiting tenants (after new capacity added)
   */
  async retryWaiting(recoveryEventId: string): Promise<RecoveryReport> {
    const event = this.db.select().from(recoveryEvents).where(eq(recoveryEvents.id, recoveryEventId)).get();

    if (!event) {
      throw new Error(`Recovery event ${recoveryEventId} not found`);
    }

    // Get all waiting items
    const waitingItems = this.db
      .select()
      .from(recoveryItems)
      .where(eq(recoveryItems.recoveryEventId, recoveryEventId))
      .all()
      .filter((item) => item.status === "waiting");

    logger.info(`Retrying ${waitingItems.length} waiting tenants for event ${recoveryEventId}`);

    const report: RecoveryReport = {
      recovered: [],
      failed: [],
      skipped: [],
      waiting: [],
    };

    for (const item of waitingItems) {
      // Look up the actual bot instance to get the correct ID
      const botInstance = this.db
        .select()
        .from(botInstances)
        .where(and(eq(botInstances.tenantId, item.tenant), eq(botInstances.nodeId, item.sourceNode)))
        .get();

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
      this.db
        .update(recoveryItems)
        .set({ status: "retried", retryCount: sql`retry_count + 1`, completedAt: Math.floor(Date.now() / 1000) })
        .where(eq(recoveryItems.id, item.id))
        .run();
    }

    // Update event with new counts
    this.db
      .update(recoveryEvents)
      .set({
        tenantsRecovered: (event.tenantsRecovered ?? 0) + report.recovered.length,
        tenantsFailed: (event.tenantsFailed ?? 0) + report.failed.length,
        tenantsWaiting: report.waiting.length,
        status: report.waiting.length > 0 ? "partial" : "completed",
        completedAt: report.waiting.length === 0 ? Math.floor(Date.now() / 1000) : event.completedAt,
      })
      .where(eq(recoveryEvents.id, recoveryEventId))
      .run();

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
    const openEvents = this.db
      .select()
      .from(recoveryEvents)
      .where(inArray(recoveryEvents.status, ["in_progress", "partial"]))
      .all();

    for (const event of openEvents) {
      try {
        // Get waiting items for this event
        const waitingItems = this.db
          .select()
          .from(recoveryItems)
          .where(and(eq(recoveryItems.recoveryEventId, event.id), eq(recoveryItems.status, "waiting")))
          .all();

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
        this.finalizeEventIfComplete(event.id);
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
      this.db
        .update(recoveryItems)
        .set({
          status: "failed",
          reason,
          completedAt: now,
        })
        .where(eq(recoveryItems.id, item.id))
        .run();
    }

    // Update event failed count and recalculate waiting count
    const event = this.db.select().from(recoveryEvents).where(eq(recoveryEvents.id, eventId)).get();
    if (event) {
      const remainingWaiting = this.db
        .select()
        .from(recoveryItems)
        .where(and(eq(recoveryItems.recoveryEventId, eventId), eq(recoveryItems.status, "waiting")))
        .all();

      this.db
        .update(recoveryEvents)
        .set({
          tenantsFailed: (event.tenantsFailed ?? 0) + items.length,
          tenantsWaiting: remainingWaiting.length,
          status: remainingWaiting.length > 0 ? "partial" : "completed",
          completedAt: remainingWaiting.length === 0 ? now : event.completedAt,
        })
        .where(eq(recoveryEvents.id, eventId))
        .run();
    }

    await this.notifier.waitingTenantsExpired(eventId, items.length, reason);

    logger.warn(`Marked ${items.length} waiting items as failed for event ${eventId}`, { reason });
  }

  /**
   * Check if all items in an event are resolved and mark event as "completed" if so.
   */
  private finalizeEventIfComplete(eventId: string): void {
    const remainingWaiting = this.db
      .select()
      .from(recoveryItems)
      .where(and(eq(recoveryItems.recoveryEventId, eventId), eq(recoveryItems.status, "waiting")))
      .all();

    if (remainingWaiting.length === 0) {
      const event = this.db.select().from(recoveryEvents).where(eq(recoveryEvents.id, eventId)).get();
      if (event && event.status !== "completed") {
        this.db
          .update(recoveryEvents)
          .set({
            status: "completed",
            tenantsWaiting: 0,
            completedAt: Math.floor(Date.now() / 1000),
          })
          .where(eq(recoveryEvents.id, eventId))
          .run();
      }
    }
  }

  /**
   * Get recovery event history
   */
  listEvents(limit = 50): RecoveryEvent[] {
    return this.db.select().from(recoveryEvents).limit(limit).all();
  }

  /**
   * Get recovery items for a specific event
   */
  getEventDetails(eventId: string): { event: RecoveryEvent | undefined; items: RecoveryItem[] } {
    const event = this.db.select().from(recoveryEvents).where(eq(recoveryEvents.id, eventId)).get();
    const items = this.db.select().from(recoveryItems).where(eq(recoveryItems.recoveryEventId, eventId)).all();

    return { event, items };
  }
}
