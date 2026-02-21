import { logger } from "../config/logger.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import type { INodeCommandBus } from "./node-command-bus.js";
import type { INodeRepository } from "./node-repository.js";

export interface MigrationResult {
  success: boolean;
  botId: string;
  sourceNodeId: string;
  targetNodeId: string;
  downtimeMs: number;
  error?: string;
}

/**
 * Handles single-tenant live migration: export -> upload -> download -> stop -> import.
 * Rollback to source on failure.
 *
 * CRITICAL: NEVER call docker rm on tenant containers.
 */
export class MigrationOrchestrator {
  constructor(
    private readonly commandBus: INodeCommandBus,
    private readonly botInstanceRepo: IBotInstanceRepository,
    private readonly nodeRepo: INodeRepository,
  ) {}

  async migrate(botId: string, targetNodeId?: string, estimatedMb?: number): Promise<MigrationResult> {
    const startTime = Date.now();

    // 1. Look up bot instance
    const instance = this.botInstanceRepo.getById(botId);
    if (!instance) {
      return {
        success: false,
        botId,
        sourceNodeId: "unknown",
        targetNodeId: targetNodeId ?? "unknown",
        downtimeMs: 0,
        error: "Bot instance not found",
      };
    }

    const sourceNodeId = instance.nodeId;
    if (!sourceNodeId) {
      return {
        success: false,
        botId,
        sourceNodeId: "unassigned",
        targetNodeId: targetNodeId ?? "unknown",
        downtimeMs: 0,
        error: "Bot has no assigned node",
      };
    }

    // 2. Determine target node
    let resolvedTarget = targetNodeId;
    if (!resolvedTarget) {
      const requiredMb = estimatedMb ?? 100;
      const placement = this.nodeRepo.findBestTarget(sourceNodeId, requiredMb);
      if (!placement) {
        return {
          success: false,
          botId,
          sourceNodeId,
          targetNodeId: "none",
          downtimeMs: 0,
          error: "No node with sufficient capacity",
        };
      }
      resolvedTarget = placement.id;
    }

    if (resolvedTarget === sourceNodeId) {
      return {
        success: false,
        botId,
        sourceNodeId,
        targetNodeId: resolvedTarget,
        downtimeMs: 0,
        error: "Source and target are the same node",
      };
    }

    const containerName = `tenant_${instance.tenantId}`;

    logger.info(`Starting migration of bot ${botId} (${containerName}): ${sourceNodeId} -> ${resolvedTarget}`);

    try {
      // 3. Export container on source node
      logger.info(`[migrate] Exporting ${containerName} on ${sourceNodeId}`);
      await this.commandBus.send(sourceNodeId, {
        type: "bot.export",
        payload: { name: containerName },
      });

      // 4. Upload to DO Spaces
      logger.info(`[migrate] Uploading ${containerName} backup to Spaces`);
      await this.commandBus.send(sourceNodeId, {
        type: "backup.upload",
        payload: { filename: `${containerName}.tar.gz` },
      });

      // 5. Download on target node
      logger.info(`[migrate] Downloading ${containerName} backup on ${resolvedTarget}`);
      await this.commandBus.send(resolvedTarget, {
        type: "backup.download",
        payload: { filename: `${containerName}.tar.gz` },
      });

      // 6. Stop container on source — DOWNTIME STARTS
      const downtimeStart = Date.now();
      logger.info(`[migrate] Stopping ${containerName} on ${sourceNodeId}`);
      await this.commandBus.send(sourceNodeId, {
        type: "bot.stop",
        payload: { name: containerName },
      });

      const image = process.env.WOPR_BOT_IMAGE ?? "ghcr.io/wopr-network/wopr:stable";

      try {
        // 7. Import + start on target
        logger.info(`[migrate] Importing ${containerName} on ${resolvedTarget}`);
        await this.commandBus.send(resolvedTarget, {
          type: "bot.import",
          payload: { name: containerName, image, env: {} },
        });

        // 8. Verify running on target
        logger.info(`[migrate] Verifying ${containerName} on ${resolvedTarget}`);
        await this.commandBus.send(resolvedTarget, {
          type: "bot.inspect",
          payload: { name: containerName },
        });

        // 9. Update routing — DOWNTIME ENDS
        this.botInstanceRepo.reassign(botId, resolvedTarget);
      } catch (migrationErr) {
        // Rollback: restart source container
        logger.error(`[migrate] Migration failed after stop for bot ${botId}, attempting source restart`, {
          err: migrationErr instanceof Error ? migrationErr.message : String(migrationErr),
        });
        try {
          await this.commandBus.send(sourceNodeId, {
            type: "bot.start",
            payload: { name: containerName },
          });
          logger.info(`[migrate] Source container ${containerName} restarted on ${sourceNodeId}`);
        } catch (restartErr) {
          logger.error(`[migrate] Failed to restart source container ${containerName} on ${sourceNodeId}`, {
            err: restartErr instanceof Error ? restartErr.message : String(restartErr),
          });
        }
        throw migrationErr;
      }

      const downtimeMs = Date.now() - downtimeStart;
      logger.info(
        `[migrate] Migration complete: ${botId} ${sourceNodeId} -> ${resolvedTarget} (downtime: ${downtimeMs}ms)`,
      );

      return {
        success: true,
        botId,
        sourceNodeId,
        targetNodeId: resolvedTarget,
        downtimeMs,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[migrate] Migration failed for bot ${botId}`, { err: message });
      return {
        success: false,
        botId,
        sourceNodeId,
        targetNodeId: resolvedTarget,
        downtimeMs: Date.now() - startTime,
        error: message,
      };
    }
  }
}
