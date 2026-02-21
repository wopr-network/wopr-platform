import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { logger } from "../config/logger.js";
import type * as schema from "../db/schema/index.js";
import { botInstances, nodes, nodeTransitions } from "../db/schema/index.js";
import type { NodeConnectionManager } from "./node-connection-manager.js";

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
    private readonly db: BetterSQLite3Database<typeof schema>,
    private readonly nodeConnections: NodeConnectionManager,
  ) {}

  async clean(request: OrphanCleanupRequest): Promise<OrphanCleanupResult> {
    const { nodeId, runningContainers } = request;

    logger.info(`OrphanCleaner: starting cleanup on node ${nodeId}`, {
      containerCount: runningContainers.length,
    });

    // 1. Get all bot instances assigned to this node
    const assigned = this.db.select().from(botInstances).where(eq(botInstances.nodeId, nodeId)).all();

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
        await this.nodeConnections.sendCommand(nodeId, {
          type: "bot.stop",
          payload: { name: containerName },
        });
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

    // 3. Transition node to active regardless of stop results
    const now = Math.floor(Date.now() / 1000);

    // Query the current node status so the audit row reflects reality
    const currentNode = this.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
    const fromStatus = currentNode?.status ?? "unknown";

    // Wrap status update and audit insert in a transaction to prevent partial writes
    this.db.transaction((tx) => {
      tx.update(nodes).set({ status: "active", updatedAt: now }).where(eq(nodes.id, nodeId)).run();

      // 4. Record transition audit trail
      tx.insert(nodeTransitions)
        .values({
          id: randomUUID(),
          nodeId,
          fromStatus,
          toStatus: "active",
          reason: "cleanup_complete",
          triggeredBy: "orphan_cleaner",
          createdAt: now,
        })
        .run();
    });

    logger.info(`OrphanCleaner: cleanup complete on node ${nodeId}`, {
      stopped: stopped.length,
      kept: kept.length,
      errors: errors.length,
    });

    return { nodeId, stopped, kept, errors };
  }
}
