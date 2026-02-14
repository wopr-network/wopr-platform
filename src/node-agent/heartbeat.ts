import { freemem, totalmem, uptime } from "node:os";
import { logger } from "../config/logger.js";
import type { DockerManager } from "./docker.js";
import { type ContainerMetric, type HeartbeatMessage, TENANT_PREFIX } from "./types.js";

/**
 * Collect system metrics and build a heartbeat payload.
 *
 * Disk stats are read from /proc on Linux (no child_process).
 */
export async function collectHeartbeat(nodeId: string, dockerManager: DockerManager): Promise<HeartbeatMessage> {
  const memTotalMb = Math.round(totalmem() / 1024 / 1024);
  const memUsedMb = memTotalMb - Math.round(freemem() / 1024 / 1024);

  const disk = await getDiskStats();
  const containers = await collectContainerMetrics(dockerManager);

  return {
    type: "heartbeat",
    node_id: nodeId,
    uptime_s: Math.round(uptime()),
    memory_total_mb: memTotalMb,
    memory_used_mb: memUsedMb,
    disk_total_gb: disk.totalGb,
    disk_used_gb: disk.usedGb,
    containers,
  };
}

/** Read disk stats from /proc/mounts + statfs. Falls back gracefully. */
async function getDiskStats(): Promise<{ totalGb: number; usedGb: number }> {
  try {
    const { statfsSync } = await import("node:fs");
    const stats = statfsSync("/");
    const totalGb = Math.round((stats.blocks * stats.bsize) / 1024 / 1024 / 1024);
    const freeGb = Math.round((stats.bavail * stats.bsize) / 1024 / 1024 / 1024);
    return { totalGb, usedGb: totalGb - freeGb };
  } catch {
    logger.warn("Could not read disk stats from statfs, returning zeros");
    return { totalGb: 0, usedGb: 0 };
  }
}

/** Collect per-container metrics for tenant containers. */
async function collectContainerMetrics(dockerManager: DockerManager): Promise<ContainerMetric[]> {
  const metrics: ContainerMetric[] = [];

  try {
    const containers = await dockerManager.listTenantContainers();

    for (const info of containers) {
      const name = info.Names[0]?.replace(/^\//, "") ?? "unknown";
      if (!name.startsWith(TENANT_PREFIX)) continue;

      let memoryMb = 0;
      let uptimeS = 0;

      if (info.State === "running") {
        try {
          const container = dockerManager.docker.getContainer(info.Id);
          const stats = await container.stats({ stream: false });
          memoryMb = Math.round((stats.memory_stats?.usage ?? 0) / 1024 / 1024);

          // Calculate uptime from container start time
          const inspectInfo = await container.inspect();
          const startedAt = inspectInfo.State.StartedAt;
          if (startedAt) {
            uptimeS = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
          }
        } catch {
          // stats unavailable for this container
        }
      }

      metrics.push({
        name,
        status: info.State,
        memory_mb: memoryMb,
        uptime_s: uptimeS,
      });
    }
  } catch (err) {
    logger.error("Failed to collect container metrics", { err });
  }

  return metrics;
}
