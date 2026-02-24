/**
 * SOC 2 M4: System resource monitoring.
 *
 * Polls CPU load, memory usage, and disk usage and fires alerts when
 * thresholds are exceeded. Integrates with the existing AlertChecker pattern.
 */

import { statfs } from "node:fs/promises";
import { freemem, loadavg, totalmem } from "node:os";
import { logger } from "../config/logger.js";
import { captureMessage } from "./sentry.js";

export interface SystemResourceThresholds {
  /** CPU load average (1-min) as a ratio of CPU count. Default: 0.9 (90%) */
  cpuLoadRatio: number;
  /** Memory usage ratio. Default: 0.9 (90%) */
  memoryUsageRatio: number;
  /** Disk usage ratio. Default: 0.85 (85%) */
  diskUsageRatio: number;
}

export interface SystemResourceSnapshot {
  cpuLoad1m: number;
  cpuCount: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  timestamp: number;
}

export interface ResourceAlertState {
  cpu: boolean;
  memory: boolean;
  disk: boolean;
}

const DEFAULT_THRESHOLDS: SystemResourceThresholds = {
  cpuLoadRatio: 0.9,
  memoryUsageRatio: 0.9,
  diskUsageRatio: 0.85,
};

/**
 * Collects system resource metrics (CPU, memory, disk).
 * Designed to integrate with the AlertChecker via buildResourceAlerts().
 */
export class SystemResourceMonitor {
  private readonly thresholds: SystemResourceThresholds;
  private readonly dataPath: string;
  private lastSnapshot: SystemResourceSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly firedState: ResourceAlertState = { cpu: false, memory: false, disk: false };

  constructor(opts?: { thresholds?: Partial<SystemResourceThresholds>; dataPath?: string }) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...opts?.thresholds };
    this.dataPath = opts?.dataPath ?? "/data";
  }

  /** Start polling every intervalMs (default: 60s). */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    // Collect immediately on start
    this.collect().catch((err) => logger.warn("System resource collection failed", { err }));
    this.timer = setInterval(() => {
      this.collect().catch((err) => logger.warn("System resource collection failed", { err }));
    }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Return the last collected snapshot, or null if never collected. */
  getSnapshot(): SystemResourceSnapshot | null {
    return this.lastSnapshot;
  }

  /** Collect a snapshot now and check thresholds. */
  async collect(): Promise<SystemResourceSnapshot> {
    const cpuCount = (await import("node:os")).cpus().length;
    const [load1m] = loadavg();
    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;

    let diskUsed = 0;
    let diskTotal = 0;
    try {
      const fs = await statfs(this.dataPath);
      diskTotal = fs.bsize * fs.blocks;
      diskUsed = diskTotal - fs.bsize * fs.bavail;
    } catch {
      // statfs may fail in test environments — log and continue
      logger.debug(`System resource monitor: could not stat ${this.dataPath}`);
    }

    const snapshot: SystemResourceSnapshot = {
      cpuLoad1m: load1m,
      cpuCount,
      memoryUsedBytes: usedMem,
      memoryTotalBytes: totalMem,
      diskUsedBytes: diskUsed,
      diskTotalBytes: diskTotal,
      timestamp: Date.now(),
    };

    this.lastSnapshot = snapshot;
    this.checkThresholds(snapshot);
    return snapshot;
  }

  private checkThresholds(snap: SystemResourceSnapshot): void {
    const cpuRatio = snap.cpuCount > 0 ? snap.cpuLoad1m / snap.cpuCount : 0;
    const memRatio = snap.memoryTotalBytes > 0 ? snap.memoryUsedBytes / snap.memoryTotalBytes : 0;
    const diskRatio = snap.diskTotalBytes > 0 ? snap.diskUsedBytes / snap.diskTotalBytes : 0;

    this.fireIfChanged("cpu", cpuRatio > this.thresholds.cpuLoadRatio, {
      message: `CPU load ${(cpuRatio * 100).toFixed(1)}% exceeds ${this.thresholds.cpuLoadRatio * 100}% threshold (load=${snap.cpuLoad1m.toFixed(2)}, cores=${snap.cpuCount})`,
      value: cpuRatio,
    });

    this.fireIfChanged("memory", memRatio > this.thresholds.memoryUsageRatio, {
      message: `Memory usage ${(memRatio * 100).toFixed(1)}% exceeds ${this.thresholds.memoryUsageRatio * 100}% threshold (${toMb(snap.memoryUsedBytes)}MB / ${toMb(snap.memoryTotalBytes)}MB)`,
      value: memRatio,
    });

    this.fireIfChanged("disk", diskRatio > this.thresholds.diskUsageRatio, {
      message: `Disk usage ${(diskRatio * 100).toFixed(1)}% exceeds ${this.thresholds.diskUsageRatio * 100}% threshold (${toGb(snap.diskUsedBytes)}GB / ${toGb(snap.diskTotalBytes)}GB)`,
      value: diskRatio,
    });
  }

  private fireIfChanged(
    resource: keyof ResourceAlertState,
    firing: boolean,
    info: { message: string; value: number },
  ): void {
    const wasFiring = this.firedState[resource];
    if (firing && !wasFiring) {
      logger.warn(`System alert FIRING: ${resource}`, { message: info.message, value: info.value });
      captureMessage(`System alert: ${resource} — ${info.message}`, "warning");
      this.firedState[resource] = true;
    } else if (!firing && wasFiring) {
      logger.info(`System alert RESOLVED: ${resource}`);
      this.firedState[resource] = false;
    }
  }
}

function toMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function toGb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10;
}
