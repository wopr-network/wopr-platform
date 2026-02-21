import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { logger } from "../config/logger.js";
import type * as schema from "../db/schema/index.js";
import { botInstances, nodes } from "../db/schema/index.js";
import type { AdminNotifier } from "./admin-notifier.js";
import type { NodeConnectionManager } from "./node-connection-manager.js";
import { findPlacementExcluding } from "./placement.js";

export interface MigrationResult {
  success: boolean;
  botId: string;
  sourceNodeId: string;
  targetNodeId: string;
  downtimeMs: number;
  error?: string;
}

export interface DrainResult {
  nodeId: string;
  migrated: MigrationResult[];
  failed: MigrationResult[];
}

/**
 * Manages live tenant migrations between nodes.
 *
 * Migration flow (target: <60s downtime per tenant):
 * 1. Export container on source node (creates tar.gz)
 * 2. Upload tar.gz to DO Spaces (migrations/{containerName}.tar.gz)
 * 3. Download tar.gz on target node
 * 4. Stop container on source node  downtime starts
 * 5. Import + start container on target node
 * 6. Verify container running on target
 * 7. Update bot_instances.node_id to target  routing cutover
 * 8. downtime ends
 *
 * CRITICAL: Source container is only stopped AFTER the backup
 * is uploaded and downloaded to the target. This minimizes downtime.
 * NEVER call docker rm on tenant containers.
 */
export class MigrationManager {
  constructor(
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly nodeConnections: NodeConnectionManager,
    private readonly notifier: AdminNotifier,
  ) {}

  /**
   * Migrate a single tenant (bot) from its current node to a specific target.
   * If targetNodeId is not specified, auto-selects via bin-packing.
   */
  async migrateTenant(botId: string, targetNodeId?: string, estimatedMb?: number): Promise<MigrationResult> {
    const startTime = Date.now();

    // 1. Look up bot instance to find current node
    const instance = this.db.select().from(botInstances).where(eq(botInstances.id, botId)).get();

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
      const allNodes = this.db.select().from(nodes).all();
      const placement = findPlacementExcluding(allNodes, [sourceNodeId]);
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
      resolvedTarget = placement.nodeId;
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
      await this.nodeConnections.sendCommand(sourceNodeId, {
        type: "bot.export",
        payload: { name: containerName },
      });

      // 4. Upload to DO Spaces
      logger.info(`[migrate] Uploading ${containerName} backup to Spaces`);
      await this.nodeConnections.sendCommand(sourceNodeId, {
        type: "backup.upload",
        payload: { filename: `${containerName}.tar.gz` },
      });

      // 5. Download on target node
      logger.info(`[migrate] Downloading ${containerName} backup on ${resolvedTarget}`);
      await this.nodeConnections.sendCommand(resolvedTarget, {
        type: "backup.download",
        payload: { filename: `${containerName}.tar.gz` },
      });

      // 6. Stop container on source — DOWNTIME STARTS
      const downtimeStart = Date.now();
      logger.info(`[migrate] Stopping ${containerName} on ${sourceNodeId}`);
      await this.nodeConnections.sendCommand(sourceNodeId, {
        type: "bot.stop",
        payload: { name: containerName },
      });

      const image = process.env.WOPR_BOT_IMAGE ?? "ghcr.io/wopr-network/wopr:stable";

      try {
        // 7. Import + start on target
        logger.info(`[migrate] Importing ${containerName} on ${resolvedTarget}`);
        await this.nodeConnections.sendCommand(resolvedTarget, {
          type: "bot.import",
          payload: {
            name: containerName,
            image,
            env: {},
          },
        });

        // 8. Verify running on target
        logger.info(`[migrate] Verifying ${containerName} on ${resolvedTarget}`);
        await this.nodeConnections.sendCommand(resolvedTarget, {
          type: "bot.inspect",
          payload: { name: containerName },
        });

        // 9. Update routing table — DOWNTIME ENDS
        this.nodeConnections.reassignTenant(botId, resolvedTarget);

        // 9b. Persist node assignment to DB so routing survives platform restart
        this.db
          .update(botInstances)
          .set({ nodeId: resolvedTarget, updatedAt: new Date().toISOString() })
          .where(eq(botInstances.id, botId))
          .run();

        // 10. Update node capacity tracking
        const memoryMb = estimatedMb ?? 100;
        this.nodeConnections.addNodeCapacity(resolvedTarget, memoryMb);
        this.nodeConnections.addNodeCapacity(sourceNodeId, -memoryMb);
      } catch (migrationErr) {
        // Attempt to restart the source container to restore service before re-throwing
        logger.error(`[migrate] Migration failed after stop for bot ${botId}, attempting source restart`, {
          err: migrationErr instanceof Error ? migrationErr.message : String(migrationErr),
        });
        try {
          await this.nodeConnections.sendCommand(sourceNodeId, {
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

  /**
   * Drain a node: migrate ALL tenants off, then mark as "draining" -> "offline".
   *
   * Use this before decommissioning a node or for maintenance.
   * After all tenants are migrated, the node can be safely destroyed.
   */
  async drainNode(nodeId: string): Promise<DrainResult> {
    logger.info(`Starting drain of node ${nodeId}`);

    // Mark node as draining (prevents new placements)
    this.db
      .update(nodes)
      .set({ status: "draining", updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(nodes.id, nodeId))
      .run();

    // Get all tenants on this node
    const tenants = this.nodeConnections.getNodeTenants(nodeId);
    logger.info(`Draining ${tenants.length} tenants from node ${nodeId}`);

    const migrated: MigrationResult[] = [];
    const failed: MigrationResult[] = [];

    for (const tenant of tenants) {
      const result = await this.migrateTenant(tenant.id, undefined, tenant.estimatedMb);
      if (result.success) {
        migrated.push(result);
      } else {
        failed.push(result);
      }
    }

    // Mark node as offline (all tenants migrated or failed)
    const finalStatus = failed.length === 0 ? "offline" : "draining";
    this.db
      .update(nodes)
      .set({ status: finalStatus, updatedAt: Math.floor(Date.now() / 1000) })
      .where(eq(nodes.id, nodeId))
      .run();

    if (failed.length > 0) {
      await this.notifier.capacityOverflow(nodeId, failed.length, tenants.length);
    }

    logger.info(`Drain complete for node ${nodeId}: ${migrated.length} migrated, ${failed.length} failed`);

    return { nodeId, migrated, failed };
  }
}
