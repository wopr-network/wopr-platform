import { statfsSync } from "node:fs";
import { logger } from "../config/logger.js";
import type { DockerManager } from "./docker.js";
import { type HealthEvent, TENANT_PREFIX } from "./types.js";

/** Disk usage threshold (percentage) to trigger low disk alerts */
const DISK_WARN_THRESHOLD = 85;

/** How often to check disk usage (ms) */
const DISK_CHECK_INTERVAL_MS = 60_000;

/**
 * Monitors Docker events for tenant container health and reports events
 * back to the platform via the provided callback.
 */
export class HealthMonitor {
  private readonly dockerManager: DockerManager;
  private readonly nodeId: string;
  private readonly onEvent: (event: HealthEvent) => void;
  private abortController: AbortController | null = null;
  private diskCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(dockerManager: DockerManager, nodeId: string, onEvent: (event: HealthEvent) => void) {
    this.dockerManager = dockerManager;
    this.nodeId = nodeId;
    this.onEvent = onEvent;
  }

  /** Start watching Docker events and disk usage. */
  async start(): Promise<void> {
    this.abortController = new AbortController();
    this.watchDockerEvents();
    this.startDiskCheck();
    logger.info("Health monitor started");
  }

  /** Stop all monitoring. */
  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    if (this.diskCheckInterval) {
      clearInterval(this.diskCheckInterval);
      this.diskCheckInterval = null;
    }
    logger.info("Health monitor stopped");
  }

  private async watchDockerEvents(): Promise<void> {
    try {
      const stream = await this.dockerManager.getEventStream({
        filters: { type: ["container"] },
      });

      stream.on("data", (chunk: Buffer) => {
        try {
          const event = JSON.parse(chunk.toString());
          this.handleDockerEvent(event);
        } catch {
          // malformed event data, skip
        }
      });

      stream.on("error", (err: Error) => {
        if (this.abortController?.signal.aborted) return;
        logger.error("Docker event stream error, restarting in 5s", { err: err.message });
        setTimeout(() => this.watchDockerEvents(), 5000);
      });

      stream.on("end", () => {
        if (this.abortController?.signal.aborted) return;
        logger.warn("Docker event stream ended, restarting in 5s");
        setTimeout(() => this.watchDockerEvents(), 5000);
      });
    } catch (err) {
      logger.error("Failed to open Docker event stream, retrying in 5s", { err });
      if (!this.abortController?.signal.aborted) {
        setTimeout(() => this.watchDockerEvents(), 5000);
      }
    }
  }

  private handleDockerEvent(event: {
    Action?: string;
    Actor?: { Attributes?: { name?: string; exitCode?: string } };
  }): void {
    const containerName = event.Actor?.Attributes?.name;
    if (!containerName?.startsWith(TENANT_PREFIX)) return;

    const action = event.Action;
    const exitCode = event.Actor?.Attributes?.exitCode;

    if (action === "die") {
      const isOom = exitCode === "137";
      const eventType = isOom ? "oom_killed" : "died";
      const message = isOom
        ? `Container ${containerName} was OOM-killed (exit 137)`
        : `Container ${containerName} died (exit ${exitCode ?? "unknown"})`;

      logger.warn(message);
      this.onEvent(this.buildEvent(containerName, eventType, message));
      this.attemptRestart(containerName, isOom);
    } else if (action === "health_status: unhealthy") {
      const message = `Container ${containerName} health check failed`;
      logger.warn(message);
      this.onEvent(this.buildEvent(containerName, "unhealthy", message));
    }
  }

  private async attemptRestart(name: string, wasOom: boolean): Promise<void> {
    try {
      logger.info(`Attempting restart of ${name}`);
      await this.dockerManager.restartBot(name);
      const message = `Container ${name} restarted${wasOom ? " after OOM kill" : ""}`;
      logger.info(message);
      this.onEvent(this.buildEvent(name, "restarted", message));
    } catch (err) {
      logger.error(`Failed to restart ${name}`, { err });
    }
  }

  private startDiskCheck(): void {
    this.diskCheckInterval = setInterval(() => this.checkDisk(), DISK_CHECK_INTERVAL_MS);
  }

  private checkDisk(): void {
    try {
      const stats = statfsSync("/");
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      const usedPercent = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);

      if (usedPercent >= DISK_WARN_THRESHOLD) {
        const message = `Disk usage at ${usedPercent}% (threshold: ${DISK_WARN_THRESHOLD}%)`;
        logger.warn(message);
        this.onEvent(this.buildEvent("system", "disk_low", message));
      }
    } catch {
      // statfs not available (e.g. in tests), skip
    }
  }

  private buildEvent(container: string, event: HealthEvent["event"], message: string): HealthEvent {
    return {
      type: "health_event",
      node_id: this.nodeId,
      container,
      event,
      message,
      timestamp: new Date().toISOString(),
    };
  }
}
