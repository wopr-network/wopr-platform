import { randomUUID } from "node:crypto";
import { logger } from "../config/logger.js";
import type { AdminNotifier, RecoveryReport } from "./admin-notifier.js";
import type { CommandResult } from "./node-connection-manager.js";
import type { NodeStatus } from "./node-state-machine.js";
import type { NewRecoveryEvent, NewRecoveryItem, Node, RecoveryEvent, RecoveryItem } from "./repository-types.js";
import type { BotProfile } from "./types.js";

// ---------------------------------------------------------------------------
// Interface stubs for sibling PRs not yet merged
// TODO: Replace with imports once these PRs merge:
//   WOP-864: import type { INodeRepository } from "./node-repository.js"
//   WOP-865: import type { IBotProfileRepository } from "./bot-profile-repository.js"
//   WOP-867: import type { IRecoveryRepository } from "./recovery-repository.js"
//   WOP-869: import type { INodeCommandBus } from "./node-command-bus.js"
// ---------------------------------------------------------------------------

export interface INodeRepository {
  getById(id: string): Node | null;
  /**
   * Validates the transition via the node state machine and writes an audit
   * log entry atomically. Throws InvalidTransitionError if the transition is
   * not permitted.
   */
  transition(id: string, to: NodeStatus, reason: string, triggeredBy: string): Node;
  list(statuses?: NodeStatus[]): Node[];
}

export interface IBotProfileRepository {
  /** Synchronous — DrizzleBotProfileRepository uses synchronous SQLite queries. */
  get(id: string): BotProfile | null;
}

export interface IRecoveryRepository {
  createEvent(data: NewRecoveryEvent): RecoveryEvent;
  updateEvent(id: string, data: Partial<RecoveryEvent>): RecoveryEvent;
  getEvent(id: string): RecoveryEvent | null;
  createItem(data: NewRecoveryItem): RecoveryItem;
  updateItem(id: string, data: Partial<RecoveryItem>): RecoveryItem;
  listOpenEvents(): RecoveryEvent[];
  getWaitingItems(eventId: string): RecoveryItem[];
  incrementRetryCount(itemId: string): void;
}

export interface INodeCommandBus {
  send(nodeId: string, command: Omit<{ type: string; payload: Record<string, unknown> }, "id">): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Per-tenant recovery info with tier for priority sorting.
 *
 * IMPORTANT: The `getTenants` callback provided to the constructor MUST return
 * tenants pre-sorted by tier priority: enterprise > pro > starter > free.
 * RecoveryOrchestrator processes tenants in the order it receives them.
 */
export interface TenantRecoveryInfo {
  botId: string;
  tenantId: string;
  name: string;
  containerName: string;
  estimatedMb: number;
  tier: string | null;
}

// ---------------------------------------------------------------------------
// RecoveryOrchestrator
// ---------------------------------------------------------------------------

/**
 * Replaces RecoveryManager with repository-based orchestration.
 *
 * Key fixes over RecoveryManager:
 * - WOP-855: reads `image` and `env` from `profileRepo.get(botId)` instead of
 *   hardcoding "ghcr.io/wopr-network/wopr:latest" and `{}`
 * - WOP-856: transitions the dead node through `recovering` → `offline` via
 *   INodeRepository.transition() (state machine validated) instead of raw DB updates
 *
 * Callers (services.ts, heartbeat-watchdog.ts, admin-recovery.ts) are updated
 * in WOP-879. Do not delete recovery-manager.ts until WOP-879 merges.
 */
export class RecoveryOrchestrator {
  private static readonly DEFAULT_IMAGE = "ghcr.io/wopr-network/wopr:latest";

  constructor(
    private readonly nodeRepo: INodeRepository,
    private readonly profileRepo: IBotProfileRepository,
    private readonly recoveryRepo: IRecoveryRepository,
    private readonly commandBus: INodeCommandBus,
    private readonly notifier: AdminNotifier,
    /**
     * Returns tenants assigned to the given node, pre-sorted by tier priority
     * (enterprise > pro > starter > free). Provided by the wiring layer (WOP-879).
     */
    private readonly getTenants: (nodeId: string) => TenantRecoveryInfo[],
    /** Finds the best active target node with at least `requiredMb` free. */
    private readonly findBestTarget: (excludeNodeId: string, requiredMb: number) => Node | null,
    /** Updates bot_instances.node_id to the new node. */
    private readonly reassignTenant: (botId: string, targetNodeId: string) => void,
    /** Adds deltaMb to the target node's used_mb. */
    private readonly addNodeCapacity: (nodeId: string, deltaMb: number) => void,
  ) {}

  /**
   * Trigger recovery of all tenants on a dead node.
   *
   * WOP-856: transitions node offline → recovering (via state machine), then
   * recovering → offline once all tenants are processed.
   */
  async triggerRecovery(deadNodeId: string, trigger: "heartbeat_timeout" | "manual"): Promise<RecoveryReport> {
    const eventId = randomUUID();

    logger.info(`Starting recovery for node ${deadNodeId}`, { eventId, trigger });

    // 1. WOP-856: Transition dead node to "recovering" via state machine
    this.nodeRepo.transition(
      deadNodeId,
      "recovering",
      trigger === "heartbeat_timeout" ? "heartbeat_timeout" : "manual_recovery",
      "recovery_orchestrator",
    );

    // 2. Get all tenants assigned to this node (pre-sorted by tier priority)
    const tenants = this.getTenants(deadNodeId);

    // 3. Create recovery event via repository
    this.recoveryRepo.createEvent({
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

    // 5. WOP-856: Transition node from "recovering" to "offline"
    this.nodeRepo.transition(deadNodeId, "offline", "recovery_complete", "recovery_orchestrator");

    // 6. Finalize recovery event
    const finalStatus = report.waiting.length > 0 ? "partial" : "completed";
    this.recoveryRepo.updateEvent(eventId, {
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
   * Recover a single tenant onto a new node.
   *
   * WOP-855: reads `image` and `env` from `profileRepo.get(botId)` instead
   * of using hardcoded defaults.
   */
  private async recoverTenant(
    eventId: string,
    deadNodeId: string,
    tenant: TenantRecoveryInfo,
    report: RecoveryReport,
  ): Promise<void> {
    const itemId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const backupKey = `latest/${tenant.containerName}/latest.tar.gz`;

    logger.info(`Recovering tenant ${tenant.name} (${tenant.tenantId})`, { eventId, itemId });

    // a. Find best target node
    const target = this.findBestTarget(deadNodeId, tenant.estimatedMb);

    if (!target) {
      logger.warn(`No capacity available for tenant ${tenant.name}`, { eventId, itemId });
      report.waiting.push({ tenant: tenant.botId, reason: "no_capacity" });
      this.recoveryRepo.createItem({
        id: itemId,
        recoveryEventId: eventId,
        tenant: tenant.tenantId,
        sourceNode: deadNodeId,
        backupKey,
      });
      this.recoveryRepo.updateItem(itemId, {
        status: "waiting",
        reason: "no_capacity",
        startedAt: now,
      });
      return;
    }

    try {
      // b. Download hot backup on target node
      logger.debug(`Downloading backup for ${tenant.name} to node ${target.id}`, { backupKey });
      await this.commandBus.send(target.id, {
        type: "backup.download",
        payload: { filename: backupKey },
      });

      // c. WOP-855: Read image and env from bot profile (not hardcoded)
      let image = RecoveryOrchestrator.DEFAULT_IMAGE;
      let env: Record<string, string> = {};

      const profile = this.profileRepo.get(tenant.botId);
      if (profile) {
        image = profile.image;
        env = profile.env;
      } else {
        logger.warn(`No profile found for bot ${tenant.botId} — using default image and empty env`, {
          eventId,
          itemId,
          botId: tenant.botId,
        });
      }

      // d. Import and start on target node with correct image/env
      logger.debug(`Importing ${tenant.name} on node ${target.id}`);
      await this.commandBus.send(target.id, {
        type: "bot.import",
        payload: {
          name: tenant.containerName,
          image,
          env,
        },
      });

      // e. Verify running
      logger.debug(`Verifying ${tenant.name} is running on node ${target.id}`);
      await this.commandBus.send(target.id, {
        type: "bot.inspect",
        payload: { name: tenant.containerName },
      });

      // f. Update routing (reassign tenant to new node)
      this.reassignTenant(tenant.botId, target.id);

      // g. Update target node used_mb
      this.addNodeCapacity(target.id, tenant.estimatedMb);

      logger.info(`Recovered tenant ${tenant.name} to node ${target.id}`, { eventId, itemId });
      report.recovered.push({ tenant: tenant.botId, target: target.id });

      this.recoveryRepo.createItem({
        id: itemId,
        recoveryEventId: eventId,
        tenant: tenant.tenantId,
        sourceNode: deadNodeId,
        backupKey,
      });
      this.recoveryRepo.updateItem(itemId, {
        targetNode: target.id,
        status: "recovered",
        startedAt: now,
        completedAt: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to recover tenant ${tenant.name}`, { eventId, itemId, err: reason });
      report.failed.push({ tenant: tenant.botId, reason });

      this.recoveryRepo.createItem({
        id: itemId,
        recoveryEventId: eventId,
        tenant: tenant.tenantId,
        sourceNode: deadNodeId,
        backupKey,
      });
      this.recoveryRepo.updateItem(itemId, {
        targetNode: target?.id ?? null,
        status: "failed",
        reason,
        startedAt: now,
        completedAt: Math.floor(Date.now() / 1000),
      });
    }
  }

  /**
   * Retry recovery for waiting tenants (e.g., after new capacity is added).
   */
  async retryWaiting(recoveryEventId: string): Promise<RecoveryReport> {
    const event = this.recoveryRepo.getEvent(recoveryEventId);
    if (!event) {
      throw new Error(`Recovery event ${recoveryEventId} not found`);
    }

    const waitingItems = this.recoveryRepo.getWaitingItems(recoveryEventId);

    logger.info(`Retrying ${waitingItems.length} waiting tenants for event ${recoveryEventId}`);

    const report: RecoveryReport = {
      recovered: [],
      failed: [],
      skipped: [],
      waiting: [],
    };

    const allTenants = this.getTenants(event.nodeId);

    for (const item of waitingItems) {
      const tenant = allTenants.find((t) => t.tenantId === item.tenant);

      if (!tenant) {
        report.failed.push({ tenant: item.tenant, reason: "bot_instance_not_found" });
        continue;
      }

      await this.recoverTenant(recoveryEventId, event.nodeId, tenant, report);

      // Mark old waiting item as retried
      this.recoveryRepo.updateItem(item.id, {
        status: "recovered" as RecoveryItem["status"],
        completedAt: Math.floor(Date.now() / 1000),
      });
      this.recoveryRepo.incrementRetryCount(item.id);
    }

    // Update event counts
    this.recoveryRepo.updateEvent(recoveryEventId, {
      tenantsRecovered: (event.tenantsRecovered ?? 0) + report.recovered.length,
      tenantsFailed: (event.tenantsFailed ?? 0) + report.failed.length,
      tenantsWaiting: report.waiting.length,
      status: (report.waiting.length > 0 ? "partial" : "completed") as RecoveryEvent["status"],
      completedAt: report.waiting.length === 0 ? Math.floor(Date.now() / 1000) : event.completedAt,
    });

    return report;
  }

  /**
   * Get open recovery events.
   */
  listEvents(): RecoveryEvent[] {
    return this.recoveryRepo.listOpenEvents();
  }

  /**
   * Get a recovery event with its waiting items.
   *
   * NOTE: Returns only waiting items (via getWaitingItems). For all items
   * including recovered/failed, IRecoveryRepository will need a getItems()
   * method (tracked separately).
   */
  getEventDetails(eventId: string): { event: RecoveryEvent | undefined; items: RecoveryItem[] } {
    const event = this.recoveryRepo.getEvent(eventId) ?? undefined;
    const items = event ? this.recoveryRepo.getWaitingItems(eventId) : [];
    return { event, items };
  }
}
