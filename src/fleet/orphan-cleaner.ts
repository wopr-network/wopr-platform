import { logger } from "../config/logger.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import type { INodeCommandBus } from "./node-command-bus.js";
import type { INodeRepository } from "./node-repository.js";

export interface OrphanCleanupRequest {
  nodeId: string;
  /** Container names currently running on this node (e.g. ["tenant_abc", "tenant_def"]) */
  runningContainers: string[];
}

export interface OrphanCleanupResult {
  nodeId: string;
  stopped: string[];
  kept: string[];
  errors: Array<{ container: string; error: string }>;
}

/**
 * Stops stale containers on a rebooted node whose bots have been
 * migrated elsewhere during the outage, then transitions the node to active.
 */
export class OrphanCleaner {
  constructor(
    private readonly nodeRepo: INodeRepository,
    private readonly botInstanceRepo: IBotInstanceRepository,
    private readonly commandBus: INodeCommandBus,
  ) {}

  async clean(request: OrphanCleanupRequest): Promise<OrphanCleanupResult> {
    const { nodeId, runningContainers } = request;

    logger.info(`OrphanCleaner: starting cleanup on node ${nodeId}`, {
      containerCount: runningContainers.length,
    });

    // 1. Get all bot instances assigned to this node
    const assigned = this.botInstanceRepo.listByNode(nodeId);
    const assignedTenantIds = new Set(assigned.map((b) => b.tenantId));

    const stopped: string[] = [];
    const kept: string[] = [];
    const errors: Array<{ container: string; error: string }> = [];

    // 2. For each running tenant_* container, check assignment
    for (const containerName of runningContainers) {
      if (!containerName.startsWith("tenant_")) {
        continue; // skip non-tenant containers
      }

      const tenantId = containerName.slice("tenant_".length);

      if (assignedTenantIds.has(tenantId)) {
        kept.push(containerName);
        continue;
      }

      // Orphan: bot is no longer assigned to this node
      try {
        const result = await this.commandBus.send(nodeId, {
          type: "bot.stop",
          payload: { name: containerName },
        });
        if (!result.success) {
          const message = result.error ?? "stop command returned success: false";
          errors.push({ container: containerName, error: message });
          logger.warn(`OrphanCleaner: stop command failed for ${containerName} on ${nodeId}`, {
            error: message,
          });
          continue;
        }
        stopped.push(containerName);
        logger.info(`OrphanCleaner: stopped orphan ${containerName} on ${nodeId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ container: containerName, error: message });
        logger.warn(`OrphanCleaner: failed to stop ${containerName} on ${nodeId}`, {
          error: message,
        });
      }
    }

    // 3. Transition node to active via state machine
    this.nodeRepo.transition(nodeId, "active", "cleanup_complete", "orphan_cleaner");

    logger.info(`OrphanCleaner: cleanup complete on node ${nodeId}`, {
      stopped: stopped.length,
      kept: kept.length,
      errors: errors.length,
    });

    return { nodeId, stopped, kept, errors };
  }
}
