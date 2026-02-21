import { logger } from "../config/logger.js";
import type { INodeCommandBus } from "../fleet/node-command-bus.js";
import type { RestoreLogStore } from "./restore-log-store.js";
import type { SpacesClient } from "./spaces-client.js";

export interface RestoreResult {
  success: boolean;
  restoreLogId: string;
  preRestoreKey: string | null;
  snapshotKey: string;
  downtimeMs: number;
  error?: string;
}

export class RestoreService {
  private readonly spaces: SpacesClient;
  private readonly commandBus: INodeCommandBus;
  private readonly restoreLog: RestoreLogStore;

  constructor(opts: {
    spaces: SpacesClient;
    commandBus: INodeCommandBus;
    restoreLog: RestoreLogStore;
  }) {
    this.spaces = opts.spaces;
    this.commandBus = opts.commandBus;
    this.restoreLog = opts.restoreLog;
  }

  /**
   * List available snapshots for a tenant from DO Spaces.
   * Searches both nightly/ and latest/ prefixes.
   * Returns sorted newest-first.
   */
  async listSnapshots(tenantId: string): Promise<Array<{ key: string; date: string; sizeMb: number }>> {
    const tenantContainer = `tenant_${tenantId}`;

    // List nightly snapshots across all nodes
    const nightlyObjects = await this.spaces.list(`nightly/`);
    // Filter to this tenant's backups (path contains /tenant_{tenantId}/)
    const tenantNightly = nightlyObjects.filter((o) => o.path.includes(`/${tenantContainer}/`));

    // Also check for hot backups
    const latestObjects = await this.spaces.list(`latest/${tenantContainer}/`);

    const allObjects = [...tenantNightly, ...latestObjects];

    // Sort newest first
    allObjects.sort((a, b) => b.date.localeCompare(a.date));

    return allObjects.map((o) => ({
      key: o.path,
      date: o.date,
      sizeMb: Math.round((o.size / (1024 * 1024)) * 100) / 100,
    }));
  }

  /**
   * Restore a tenant's bot from a specific snapshot.
   *
   * Flow:
   * 1. Take pre-restore safety snapshot (export current container)
   * 2. Upload pre-restore snapshot to DO Spaces
   * 3. Stop current container
   * 4. Remove current container
   * 5. Download backup snapshot from DO Spaces to node
   * 6. Import snapshot as new image and start container
   * 7. Verify container is running
   * 8. Log the restore event
   */
  async restore(params: {
    tenantId: string;
    nodeId: string;
    snapshotKey: string;
    restoredBy: string;
    reason?: string;
  }): Promise<RestoreResult> {
    const containerName = `tenant_${params.tenantId}`;
    const preRestoreKey = `pre-restore/${containerName}_pre_restore_${Date.now()}.tar.gz`;
    const startTime = Date.now();

    logger.info(`Starting restore for ${containerName} on node ${params.nodeId}`, {
      snapshotKey: params.snapshotKey,
      restoredBy: params.restoredBy,
    });

    // Track whether we've crossed the point of no return (container removed).
    // If true and a later step fails, we must attempt recovery from preRestoreKey.
    let containerRemoved = false;

    try {
      // 1. Take pre-restore safety snapshot (export current container)
      logger.info(`Taking pre-restore snapshot of ${containerName}`);
      await this.commandBus.send(params.nodeId, {
        type: "bot.export",
        payload: { name: containerName },
      });

      // 2. Upload pre-restore snapshot to DO Spaces
      logger.info(`Uploading pre-restore snapshot to ${preRestoreKey}`);
      await this.commandBus.send(params.nodeId, {
        type: "backup.upload",
        payload: { filename: `${containerName}.tar.gz`, destination: preRestoreKey },
      });

      // 3. Stop current container
      logger.info(`Stopping container ${containerName}`);
      await this.commandBus.send(params.nodeId, {
        type: "bot.stop",
        payload: { name: containerName },
      });

      // 4. Remove current container — point of no return
      logger.info(`Removing container ${containerName}`);
      await this.commandBus.send(params.nodeId, {
        type: "bot.remove",
        payload: { name: containerName },
      });
      containerRemoved = true;

      // 5. Download backup snapshot from DO Spaces to node
      logger.info(`Downloading snapshot ${params.snapshotKey} to node ${params.nodeId}`);
      await this.commandBus.send(params.nodeId, {
        type: "backup.download",
        payload: { filename: params.snapshotKey },
      });

      // 6. Import snapshot and start new container
      logger.info(`Importing snapshot and starting ${containerName}`);
      await this.commandBus.send(params.nodeId, {
        type: "bot.import",
        payload: {
          name: containerName,
          image: `${containerName}:restored`,
          env: {},
        },
      });

      // 7. Verify container is running
      logger.info(`Verifying ${containerName} is running`);
      await this.commandBus.send(params.nodeId, {
        type: "bot.inspect",
        payload: { name: containerName },
      });

      const downtimeMs = Date.now() - startTime;

      // 8. Log the restore event
      const logEntry = this.restoreLog.record({
        tenant: params.tenantId,
        snapshotKey: params.snapshotKey,
        preRestoreKey,
        restoredBy: params.restoredBy,
        reason: params.reason,
      });

      logger.info(`Restore complete for ${containerName}`, {
        restoreLogId: logEntry.id,
        downtimeMs,
      });

      return {
        success: true,
        restoreLogId: logEntry.id,
        preRestoreKey,
        snapshotKey: params.snapshotKey,
        downtimeMs,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Restore failed for ${containerName}`, { err: errorMessage });

      // If the container was already removed, attempt to recover from the pre-restore snapshot.
      if (containerRemoved) {
        logger.warn(
          `Container ${containerName} was removed before failure — attempting recovery from ${preRestoreKey}`,
        );
        try {
          await this.commandBus.send(params.nodeId, {
            type: "backup.download",
            payload: { filename: preRestoreKey },
          });
          await this.commandBus.send(params.nodeId, {
            type: "bot.import",
            payload: {
              name: containerName,
              image: `${containerName}:pre-restore`,
              env: {},
            },
          });
          logger.info(`Recovery successful: ${containerName} restored from pre-restore snapshot`);
        } catch (recoveryErr) {
          const recoveryMessage = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
          logger.error(`CRITICAL: Recovery from pre-restore snapshot also failed for ${containerName}`, {
            preRestoreKey,
            err: recoveryMessage,
          });
        }
      }

      // Still log the failed attempt
      const logEntry = this.restoreLog.record({
        tenant: params.tenantId,
        snapshotKey: params.snapshotKey,
        preRestoreKey: null,
        restoredBy: params.restoredBy,
        reason: `FAILED: ${errorMessage}`,
      });

      return {
        success: false,
        restoreLogId: logEntry.id,
        preRestoreKey: null,
        snapshotKey: params.snapshotKey,
        downtimeMs: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }
}
