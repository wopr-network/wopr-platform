import { eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { logger } from "../config/logger.js";
import type * as schema from "../db/schema/index.js";
import { nodes } from "../db/schema/index.js";
import type { RecoveryManager } from "./recovery-manager.js";

/** Heartbeat watchdog configuration */
export interface WatchdogConfig {
  /** After 90s (3 missed heartbeats), mark node as unhealthy */
  unhealthyThresholdS?: number;
  /** After 300s (5 minutes), mark node as offline and trigger recovery */
  offlineThresholdS?: number;
  /** Check interval in milliseconds */
  checkIntervalMs?: number;
}

/**
 * Heartbeat watchdog — monitors node heartbeats and triggers recovery on failure.
 *
 * Timeline:
 * - T+90s: 3 missed heartbeats → mark node as "unhealthy"
 * - T+300s: 5 minutes → mark node as "offline" and trigger auto-recovery
 */
export class HeartbeatWatchdog {
  private readonly db: BetterSQLite3Database<typeof schema>;
  private readonly recoveryManager: RecoveryManager;
  private readonly onNodeStatusChange: (nodeId: string, newStatus: string) => void;

  private readonly UNHEALTHY_THRESHOLD_S: number;
  private readonly OFFLINE_THRESHOLD_S: number;
  private readonly CHECK_INTERVAL_MS: number;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: BetterSQLite3Database<typeof schema>,
    recoveryManager: RecoveryManager,
    onNodeStatusChange: (nodeId: string, newStatus: string) => void,
    config: WatchdogConfig = {},
  ) {
    this.db = db;
    this.recoveryManager = recoveryManager;
    this.onNodeStatusChange = onNodeStatusChange;

    this.UNHEALTHY_THRESHOLD_S = config.unhealthyThresholdS ?? 90;
    this.OFFLINE_THRESHOLD_S = config.offlineThresholdS ?? 300;
    this.CHECK_INTERVAL_MS = config.checkIntervalMs ?? 15_000;
  }

  /**
   * Start the watchdog timer
   */
  start(): void {
    if (this.timer) {
      logger.warn("Heartbeat watchdog already running");
      return;
    }

    logger.info("Starting heartbeat watchdog", {
      unhealthyThresholdS: this.UNHEALTHY_THRESHOLD_S,
      offlineThresholdS: this.OFFLINE_THRESHOLD_S,
      checkIntervalMs: this.CHECK_INTERVAL_MS,
    });

    this.timer = setInterval(() => {
      this.check();
    }, this.CHECK_INTERVAL_MS);
  }

  /**
   * Stop the watchdog timer
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Heartbeat watchdog stopped");
    }
  }

  /**
   * Check all active/unhealthy nodes for missing heartbeats
   */
  private check(): void {
    const now = Math.floor(Date.now() / 1000);
    const activeNodes = this.db
      .select()
      .from(nodes)
      .where(inArray(nodes.status, ["active", "unhealthy"]))
      .all();

    for (const node of activeNodes) {
      const lastHeartbeat = node.lastHeartbeatAt ?? 0;
      const elapsed = now - lastHeartbeat;

      // Node has been offline for 5 minutes → trigger recovery
      if (elapsed >= this.OFFLINE_THRESHOLD_S && node.status !== "offline") {
        logger.error(`Node ${node.id} offline (no heartbeat for ${elapsed}s)`, {
          nodeId: node.id,
          lastHeartbeat: node.lastHeartbeatAt,
          elapsed,
        });

        this.db.update(nodes).set({ status: "offline", updatedAt: now }).where(eq(nodes.id, node.id)).run();

        this.onNodeStatusChange(node.id, "offline");

        // Trigger recovery (async, don't wait)
        this.recoveryManager.triggerRecovery(node.id, "heartbeat_timeout").catch((err) => {
          logger.error(`Recovery failed for node ${node.id}`, { err });
        });
      }
      // Node has missed 3 heartbeats → mark unhealthy
      else if (elapsed >= this.UNHEALTHY_THRESHOLD_S && node.status === "active") {
        logger.warn(`Node ${node.id} unhealthy (no heartbeat for ${elapsed}s)`, {
          nodeId: node.id,
          lastHeartbeat: node.lastHeartbeatAt,
          elapsed,
        });

        this.db.update(nodes).set({ status: "unhealthy", updatedAt: now }).where(eq(nodes.id, node.id)).run();

        this.onNodeStatusChange(node.id, "unhealthy");
      }
    }
  }
}
