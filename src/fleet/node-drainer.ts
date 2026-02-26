import { logger } from "../config/logger.js";
import type { AdminNotifier } from "./admin-notifier.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import type { MigrationOrchestrator, MigrationResult } from "./migration-orchestrator.js";
import type { INodeRepository } from "./node-repository.js";

export interface DrainResult {
  nodeId: string;
  migrated: MigrationResult[];
  failed: MigrationResult[];
}

/**
 * Orchestrates full node drain: transition to draining, migrate all tenants,
 * then transition to offline.
 *
 * CRITICAL: NEVER call docker rm on tenant containers.
 */
export class NodeDrainer {
  constructor(
    private readonly migrationOrchestrator: MigrationOrchestrator,
    private readonly nodeRepo: INodeRepository,
    private readonly botInstanceRepo: IBotInstanceRepository,
    private readonly notifier: AdminNotifier,
  ) {}

  async drain(nodeId: string): Promise<DrainResult> {
    logger.info(`Starting drain of node ${nodeId}`);

    // 1. Transition node to draining (prevents new placements)
    await this.nodeRepo.transition(nodeId, "draining", "node_drain", "migration_orchestrator");

    // 2. Get all tenants on this node
    const tenants = await this.botInstanceRepo.listByNode(nodeId);
    logger.info(`Draining ${tenants.length} tenants from node ${nodeId}`);

    const migrated: MigrationResult[] = [];
    const failed: MigrationResult[] = [];

    // 3. Migrate each tenant
    for (const tenant of tenants) {
      const result = await this.migrationOrchestrator.migrate(tenant.id, undefined, 100);
      if (result.success) {
        migrated.push(result);
      } else {
        failed.push(result);
      }
    }

    // 4. Transition to offline if all succeeded, stay draining if some failed
    if (failed.length === 0) {
      await this.nodeRepo.transition(nodeId, "offline", "drain_complete", "migration_orchestrator");
    }

    // 5. Notify admin on failures
    if (failed.length > 0) {
      await this.notifier.capacityOverflow(nodeId, failed.length, tenants.length);
    }

    logger.info(`Drain complete for node ${nodeId}: ${migrated.length} migrated, ${failed.length} failed`);

    return { nodeId, migrated, failed };
  }
}
