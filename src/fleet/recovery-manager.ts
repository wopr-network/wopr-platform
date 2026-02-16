import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../config/logger.js";
import type { DrizzleDb } from "../db/index.js";
import { botInstances, nodes, tenantCustomers } from "../db/schema/index.js";
import type { RecoveryRepository } from "../domain/repositories/recovery-repository.js";
import type { AdminNotifier, RecoveryReport } from "./admin-notifier.js";
import type { NodeConnectionManager, TenantAssignment } from "./node-connection-manager.js";

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
 *
 * Uses RecoveryRepository for data persistence (async).
 */
export class RecoveryManager {
  constructor(
    private readonly db: DrizzleDb,
    private readonly nodeConnections: NodeConnectionManager,
    private readonly notifier: AdminNotifier,
    private readonly recoveryRepository: RecoveryRepository,
  ) {}

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
      estimatedMb: 100,
    }));
  }

  /**
   * Trigger recovery of all tenants on a dead node
   */
  async triggerRecovery(deadNodeId: string, trigger: "heartbeat_timeout" | "manual"): Promise<RecoveryReport> {
    const eventId = randomUUID();

    logger.info(`Starting recovery for node ${deadNodeId}`, { eventId, trigger });

    // 1. Mark node as "recovering"
    this.db.update(nodes).set({ status: "recovering" }).where(eq(nodes.id, deadNodeId)).run();

    // 2. Get all tenants assigned to this node with tier priority
    const tenants = this.getTenantsWithTierPriority(deadNodeId);

    // 3. Create recovery event
    await this.recoveryRepository.createEvent({
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

    // 5. Mark dead node as offline
    this.db.update(nodes).set({ status: "offline" }).where(eq(nodes.id, deadNodeId)).run();

    // 6. Finalize recovery event
    const finalStatus = report.waiting.length > 0 ? "partial" : "completed";
    await this.recoveryRepository.updateEvent(eventId, {
      status: finalStatus,
      tenantsRecovered: report.recovered.length,
      tenantsFailed: report.failed.length,
      tenantsWaiting: report.waiting.length,
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
  ): Promise<void> {
    const itemId = randomUUID();

    logger.info(`Recovering tenant ${tenant.name} (${tenant.tenantId})`, { eventId, itemId });

    // a. Find best target node (most free capacity, status=active)
    const target = await this.nodeConnections.findBestTarget(deadNodeId, tenant.estimatedMb);

    if (!target) {
      logger.warn(`No capacity available for tenant ${tenant.name}`, { eventId, itemId });
      report.waiting.push({ tenant: tenant.id, reason: "no_capacity" });

      await this.recoveryRepository.createItem({
        id: itemId,
        recoveryEventId: eventId,
        tenant: tenant.tenantId,
        sourceNode: deadNodeId,
        status: "waiting",
        reason: "no_capacity",
      });
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
      await this.nodeConnections.reassignTenant(tenant.id, target.id);

      // f. Update target node used_mb
      await this.nodeConnections.addNodeCapacity(target.id, tenant.estimatedMb);

      logger.info(`Recovered tenant ${tenant.name} to node ${target.id}`, { eventId, itemId });
      report.recovered.push({ tenant: tenant.id, target: target.id });

      await this.recoveryRepository.createItem({
        id: itemId,
        recoveryEventId: eventId,
        tenant: tenant.tenantId,
        sourceNode: deadNodeId,
        targetNode: target.id,
        backupKey,
        status: "recovered",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to recover tenant ${tenant.name}`, { eventId, itemId, err: reason });
      report.failed.push({ tenant: tenant.id, reason });

      await this.recoveryRepository.createItem({
        id: itemId,
        recoveryEventId: eventId,
        tenant: tenant.tenantId,
        sourceNode: deadNodeId,
        targetNode: target?.id,
        status: "failed",
        reason,
      });
    }
  }

  /**
   * Retry recovery for waiting tenants (after new capacity added)
   */
  async retryWaiting(recoveryEventId: string): Promise<RecoveryReport> {
    const event = await this.recoveryRepository.getEvent(recoveryEventId);

    if (!event) {
      throw new Error(`Recovery event ${recoveryEventId} not found`);
    }

    const waitingItems = await this.recoveryRepository.getWaitingItems(recoveryEventId);

    logger.info(`Retrying ${waitingItems.length} waiting tenants for event ${recoveryEventId}`);

    const report: RecoveryReport = {
      recovered: [],
      failed: [],
      skipped: [],
      waiting: [],
    };

    for (const item of waitingItems) {
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

      await this.recoveryRepository.updateItem(item.id, {
        status: "retried",
        completedAt: true,
      });
    }

    return report;
  }

  /**
   * Get recovery event history
   */
  async listEvents(limit = 50) {
    return this.recoveryRepository.listEvents(limit);
  }

  /**
   * Get recovery items for a specific event
   */
  async getEventDetails(eventId: string) {
    const event = await this.recoveryRepository.getEvent(eventId);
    const items = await this.recoveryRepository.getItemsByEvent(eventId);

    return { event, items };
  }
}
