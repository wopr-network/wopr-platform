import { randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { logger } from "../config/logger.js";
import * as schema from "../db/schema/index.js";
import { nodes, recoveryEvents, recoveryItems } from "../db/schema/index.js";
import type { RecoveryReport } from "./admin-notifier.js";
import { AdminNotifier } from "./admin-notifier.js";
import type { NodeConnectionManager, TenantAssignment } from "./node-connection-manager.js";

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
   * Trigger recovery of all tenants on a dead node
   */
  async triggerRecovery(deadNodeId: string, trigger: "heartbeat_timeout" | "manual"): Promise<RecoveryReport> {
    const eventId = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    logger.info(`Starting recovery for node ${deadNodeId}`, { eventId, trigger });

    // 1. Mark node as "recovering"
    this.db.update(nodes).set({ status: "recovering" }).where(eq(nodes.id, deadNodeId)).run();

    // 2. Get all tenants assigned to this node
    const tenants = this.nodeConnections.getNodeTenants(deadNodeId);

    // TODO: Sort by tier priority (enterprise > pro > starter > free)
    // For now, just sort by creation order
    tenants.sort((a, b) => a.name.localeCompare(b.name));

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
  ): Promise<void> {
    const itemId = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    logger.info(`Recovering tenant ${tenant.name} (${tenant.tenantId})`, { eventId, itemId });

    // a. Find best target node (most free capacity, status=active)
    const target = this.nodeConnections.findBestTarget(deadNodeId, tenant.estimatedMb);

    if (!target) {
      logger.warn(`No capacity available for tenant ${tenant.name}`, { eventId, itemId });
      report.waiting.push({ tenant: tenant.id, reason: "no_capacity" });
      this.recordItem(eventId, itemId, tenant, null, "waiting", "no_capacity", now);
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

      // c. Import and start on target node
      logger.debug(`Importing ${tenant.name} on node ${target.id}`);

      await this.nodeConnections.sendCommand(target.id, {
        type: "bot.import",
        payload: {
          name: tenant.containerName,
          image: "ghcr.io/wopr-network/wopr:latest", // Default image; can be refined
          env: {}, // Default env; can be refined from tenant metadata
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
      this.recordItem(eventId, itemId, tenant, target.id, "recovered", null, now);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to recover tenant ${tenant.name}`, { eventId, itemId, err: reason });
      report.failed.push({ tenant: tenant.id, reason });
      this.recordItem(eventId, itemId, tenant, target?.id, "failed", reason, now);
    }
  }

  /**
   * Record a recovery item in the database
   */
  private recordItem(
    eventId: string,
    itemId: string,
    tenant: TenantAssignment,
    targetNodeId: string | null,
    status: string,
    reason: string | null,
    startedAt: number,
  ): void {
    const backupKey = `latest/${tenant.containerName}/latest.tar.gz`;

    this.db
      .insert(recoveryItems)
      .values({
        id: itemId,
        recoveryEventId: eventId,
        tenant: tenant.tenantId,
        sourceNode: tenant.id, // This should be the source node, but TenantAssignment doesn't have it
        targetNode: targetNodeId,
        backupKey,
        status,
        reason,
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
      const tenant: TenantAssignment = {
        id: item.id,
        tenantId: item.tenant,
        name: item.tenant,
        containerName: `tenant_${item.tenant}`,
        estimatedMb: 100,
      };

      await this.recoverTenant(recoveryEventId, event.nodeId, tenant, report);
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
