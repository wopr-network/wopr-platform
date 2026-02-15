import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { logger } from "../config/logger.js";
import type * as schema from "../db/schema/index.js";
import { botInstances, nodes, recoveryEvents, recoveryItems, tenantCustomers } from "../db/schema/index.js";
import type { AdminNotifier, RecoveryReport } from "./admin-notifier.js";
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
  ): Promise<void> {
    const itemId = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    logger.info(`Recovering tenant ${tenant.name} (${tenant.tenantId})`, { eventId, itemId });

    // a. Find best target node (most free capacity, status=active)
    const target = this.nodeConnections.findBestTarget(deadNodeId, tenant.estimatedMb);

    if (!target) {
      logger.warn(`No capacity available for tenant ${tenant.name}`, { eventId, itemId });
      report.waiting.push({ tenant: tenant.id, reason: "no_capacity" });
      this.recordItem(eventId, itemId, tenant, deadNodeId, null, "waiting", "no_capacity", now);
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

      // TODO: Retrieve image/env from bot profile metadata instead of hardcoding
      // Should query fleet profile store or bot_instances metadata when available
      const image = "ghcr.io/wopr-network/wopr:latest";
      const env = {};

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
      this.recordItem(eventId, itemId, tenant, deadNodeId, target.id, "recovered", null, now);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to recover tenant ${tenant.name}`, { eventId, itemId, err: reason });
      report.failed.push({ tenant: tenant.id, reason });
      this.recordItem(eventId, itemId, tenant, deadNodeId, target?.id, "failed", reason, now);
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

      await this.recoverTenant(recoveryEventId, event.nodeId, tenant, report);

      // Mark waiting item as processed
      this.db
        .update(recoveryItems)
        .set({ status: "retried", completedAt: Math.floor(Date.now() / 1000) })
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
