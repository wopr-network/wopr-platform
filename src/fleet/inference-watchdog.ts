import { logger } from "../config/logger.js";
import type { AdminNotifier } from "./admin-notifier.js";
import type { DOClient } from "./do-client.js";
import type { IGpuNodeRepository } from "./gpu-node-repository.js";

/** Maps service name to its health-check port on the GPU node. */
const SERVICE_PORTS: Record<string, number> = {
  llama: 8080,
  chatterbox: 8081,
  whisper: 8082,
  qwen: 8083,
};

export interface InferenceWatchdogOptions {
  /** Polling interval in ms. Default: 30000 */
  intervalMs?: number;
  /** Per-endpoint fetch timeout in ms. Default: 5000 */
  healthTimeoutMs?: number;
  /** Consecutive all-down cycles before reboot. Default: 2 */
  rebootThreshold?: number;
  /** Time after reboot before marking failed (ms). Default: 600000 (10min) */
  failedTimeoutMs?: number;
}

interface NodeState {
  consecutiveAllDown: number;
  rebootedAt: number | null;
}

export class InferenceWatchdog {
  private readonly repo: IGpuNodeRepository;
  private readonly doClient: DOClient;
  private readonly notifier: AdminNotifier;

  private readonly intervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly rebootThreshold: number;
  private readonly failedTimeoutMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;

  /** In-memory per-node failure tracking. Keyed by gpu node ID. */
  private nodeStates = new Map<string, NodeState>();

  constructor(
    repo: IGpuNodeRepository,
    doClient: DOClient,
    notifier: AdminNotifier,
    options: InferenceWatchdogOptions = {},
  ) {
    this.repo = repo;
    this.doClient = doClient;
    this.notifier = notifier;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 5_000;
    this.rebootThreshold = options.rebootThreshold ?? 2;
    this.failedTimeoutMs = options.failedTimeoutMs ?? 600_000;
  }

  start(): void {
    if (this.timer) {
      logger.warn("InferenceWatchdog already running");
      return;
    }

    logger.info("Starting inference watchdog", {
      intervalMs: this.intervalMs,
      rebootThreshold: this.rebootThreshold,
      failedTimeoutMs: this.failedTimeoutMs,
    });

    this.timer = setInterval(() => {
      this.check().catch((err) => {
        logger.error("InferenceWatchdog check failed", { err });
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Inference watchdog stopped");
    }
  }

  private async check(): Promise<void> {
    const nodes = await this.repo.list(["active", "degraded"]);

    for (const node of nodes) {
      if (!node.host) continue;

      const health = await this.pollHealth(node.host);
      const now = Math.floor(Date.now() / 1000);

      await this.repo.updateServiceHealth(node.id, health, now);

      const allDown = Object.values(health).every((s) => s === "down");
      const anyUp = Object.values(health).some((s) => s === "ok");

      let state = this.nodeStates.get(node.id);
      if (!state) {
        state = { consecutiveAllDown: 0, rebootedAt: null };
        this.nodeStates.set(node.id, state);
      }

      if (anyUp) {
        if (state.consecutiveAllDown > 0 || state.rebootedAt !== null) {
          state.consecutiveAllDown = 0;
          state.rebootedAt = null;
          if (node.status === "degraded") {
            await this.repo.updateStatus(node.id, "active");
          }
        }
        continue;
      }

      if (allDown) {
        state.consecutiveAllDown++;

        if (state.rebootedAt !== null) {
          const elapsed = Date.now() - state.rebootedAt;
          if (elapsed >= this.failedTimeoutMs) {
            await this.repo.updateStatus(node.id, "failed");
            this.notifier.gpuNodeFailed(node.id).catch((err) => {
              logger.error("Failed to send gpuNodeFailed notification", { nodeId: node.id, err });
            });
            this.nodeStates.delete(node.id);
            continue;
          }
          // Still within reboot window — wait
          continue;
        }

        if (state.consecutiveAllDown >= this.rebootThreshold) {
          await this.repo.updateStatus(node.id, "degraded");
          this.notifier.gpuNodeDegraded(node.id, health).catch((err) => {
            logger.error("Failed to send gpuNodeDegraded notification", { nodeId: node.id, err });
          });

          if (node.dropletId) {
            this.doClient.rebootDroplet(Number(node.dropletId)).catch((err) => {
              logger.error("Failed to reboot droplet", { nodeId: node.id, dropletId: node.dropletId, err });
            });
          } else {
            logger.error("Cannot reboot GPU node: no dropletId", { nodeId: node.id });
          }

          state.rebootedAt = Date.now();
        }
      }
    }
  }

  private async pollHealth(host: string): Promise<Record<string, "ok" | "down">> {
    const results: Record<string, "ok" | "down"> = {};

    const checks = Object.entries(SERVICE_PORTS).map(async ([service, port]) => {
      try {
        const res = await fetch(`http://${host}:${port}/health`, {
          signal: AbortSignal.timeout(this.healthTimeoutMs),
        });
        results[service] = res.ok ? "ok" : "down";
      } catch {
        results[service] = "down";
      }
    });

    await Promise.all(checks);
    return results;
  }
}
