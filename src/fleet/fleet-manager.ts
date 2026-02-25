import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { logger } from "../config/logger.js";
import { buildDiscoveryEnv } from "../discovery/discovery-config.js";
import type { PlatformDiscoveryConfig } from "../discovery/types.js";
import type { ContainerResourceLimits } from "../monetization/quotas/resource-limits.js";
import type { NetworkPolicy } from "../network/network-policy.js";
import type { ProxyManagerInterface } from "../proxy/types.js";
import type { ProfileStore } from "./profile-store.js";
import type { BotProfile, BotStatus, ContainerStats } from "./types.js";

const CONTAINER_LABEL = "wopr.managed";
const CONTAINER_ID_LABEL = "wopr.bot-id";

export class FleetManager {
  private readonly docker: Docker;
  private readonly store: ProfileStore;
  private readonly platformDiscovery: PlatformDiscoveryConfig | undefined;
  private readonly networkPolicy: NetworkPolicy | undefined;
  private readonly proxyManager: ProxyManagerInterface | undefined;

  constructor(
    docker: Docker,
    store: ProfileStore,
    platformDiscovery?: PlatformDiscoveryConfig,
    networkPolicy?: NetworkPolicy,
    proxyManager?: ProxyManagerInterface,
  ) {
    this.docker = docker;
    this.store = store;
    this.platformDiscovery = platformDiscovery;
    this.networkPolicy = networkPolicy;
    this.proxyManager = proxyManager;
  }

  /**
   * Create a new bot: persist profile, pull image, create container.
   * Rolls back profile on container creation failure.
   *
   * @param params - Bot profile fields (without id)
   * @param resourceLimits - Optional Docker resource constraints (from tier)
   */
  async create(
    params: Omit<BotProfile, "id"> & { id?: string },
    resourceLimits?: ContainerResourceLimits,
  ): Promise<BotProfile> {
    const profile: BotProfile = { id: params.id ?? randomUUID(), ...params };

    await this.store.save(profile);

    try {
      await this.pullImage(profile.image);
      await this.createContainer(profile, resourceLimits);
    } catch (err) {
      logger.error(`Failed to create container for bot ${profile.id}, rolling back profile`, {
        err,
      });
      await this.store.delete(profile.id);
      throw err;
    }

    // Register proxy route for tenant subdomain routing (non-fatal)
    if (this.proxyManager) {
      try {
        const subdomain = profile.name.toLowerCase().replace(/_/g, "-");
        await this.proxyManager.addRoute({
          instanceId: profile.id,
          subdomain,
          upstreamHost: `wopr-${subdomain}`,
          upstreamPort: 7437,
          healthy: true,
        });
      } catch (err) {
        logger.warn("Proxy route registration failed (non-fatal)", { botId: profile.id, err });
      }
    }

    return profile;
  }

  /**
   * Start a stopped bot container.
   */
  async start(id: string): Promise<void> {
    const container = await this.findContainer(id);
    if (!container) throw new BotNotFoundError(id);
    await container.start();
    if (this.proxyManager) {
      this.proxyManager.updateHealth(id, true);
    }
    logger.info(`Started bot ${id}`);
  }

  /**
   * Stop a running bot container.
   */
  async stop(id: string): Promise<void> {
    const container = await this.findContainer(id);
    if (!container) throw new BotNotFoundError(id);
    await container.stop();
    if (this.proxyManager) {
      this.proxyManager.updateHealth(id, false);
    }
    logger.info(`Stopped bot ${id}`);
  }

  /**
   * Restart: pull new image BEFORE stopping old container to avoid downtime on pull failure.
   */
  async restart(id: string): Promise<void> {
    const profile = await this.store.get(id);
    if (!profile) throw new BotNotFoundError(id);

    // Pull new image first — if this fails, old container keeps running
    await this.pullImage(profile.image);

    const container = await this.findContainer(id);
    if (!container) throw new BotNotFoundError(id);
    await container.restart();
    logger.info(`Restarted bot ${id}`);
  }

  /**
   * Remove a bot: stop container, remove it, optionally remove volumes, delete profile.
   */
  async remove(id: string, removeVolumes = false): Promise<void> {
    const profile = await this.store.get(id);
    if (!profile) throw new BotNotFoundError(id);

    const container = await this.findContainer(id);
    if (container) {
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop();
      }
      await container.remove({ v: removeVolumes });
    }

    // Clean up tenant network if no more containers remain
    if (this.networkPolicy) {
      await this.networkPolicy.cleanupAfterRemoval(profile.tenantId);
    }

    await this.store.delete(id);
    if (this.proxyManager) {
      this.proxyManager.removeRoute(id);
    }
    logger.info(`Removed bot ${id}`);
  }

  /**
   * Get live status of a single bot.
   */
  async status(id: string): Promise<BotStatus> {
    const profile = await this.store.get(id);
    if (!profile) throw new BotNotFoundError(id);

    const container = await this.findContainer(id);
    if (!container) {
      return this.offlineStatus(profile);
    }

    return this.buildStatus(profile, container);
  }

  /**
   * List all bots with live status.
   */
  async listAll(): Promise<BotStatus[]> {
    const profiles = await this.store.list();
    return Promise.all(profiles.map((p) => this.statusForProfile(p)));
  }

  /**
   * List bots belonging to a specific tenant with live status.
   */
  async listByTenant(tenantId: string): Promise<BotStatus[]> {
    const profiles = await this.store.list();
    const tenantProfiles = profiles.filter((p) => p.tenantId === tenantId);
    return Promise.all(tenantProfiles.map((p) => this.statusForProfile(p)));
  }

  /**
   * Get container logs.
   */
  async logs(id: string, tail = 100): Promise<string> {
    const container = await this.findContainer(id);
    if (!container) throw new BotNotFoundError(id);

    const logBuffer = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });
    return logBuffer.toString("utf-8");
  }

  /** Fields that require container recreation when changed. */
  private static readonly CONTAINER_FIELDS = new Set<string>([
    "image",
    "env",
    "restartPolicy",
    "volumeName",
    "name",
    "discovery",
  ]);

  /**
   * Update a bot profile. Only recreates the container if container-relevant
   * fields changed. Rolls back the profile if container recreation fails.
   */
  async update(id: string, updates: Partial<Omit<BotProfile, "id">>): Promise<BotProfile> {
    const existing = await this.store.get(id);
    if (!existing) throw new BotNotFoundError(id);

    const updated: BotProfile = { ...existing, ...updates };

    const needsRecreate = Object.keys(updates).some((k) => FleetManager.CONTAINER_FIELDS.has(k));

    const container = await this.findContainer(id);
    if (container && needsRecreate) {
      const info = await container.inspect();
      const wasRunning = info.State.Running;

      // Save the updated profile only after pre-checks succeed
      if (updates.image) {
        await this.pullImage(updated.image);
      }

      await this.store.save(updated);

      try {
        try {
          await container.stop();
        } catch (err) {
          logger.warn(`Failed to stop container ${id} during update`, { botId: id, err });
          throw err;
        }
        try {
          await container.remove();
        } catch (err) {
          logger.warn(`Failed to remove container ${id} during update`, { botId: id, err });
          throw err;
        }
        await this.createContainer(updated);

        if (wasRunning) {
          const newContainer = await this.findContainer(id);
          if (newContainer) await newContainer.start();
        }
      } catch (err) {
        // Rollback profile to the previous state
        logger.error(`Failed to recreate container for bot ${id}, rolling back profile`, { err });
        await this.store.save(existing);
        throw err;
      }
    } else {
      // Metadata-only change or no container — just save the profile
      await this.store.save(updated);
    }

    return updated;
  }

  /**
   * Get disk usage for a bot's /data volume.
   * Returns null if the container is not running or exec fails.
   */
  async getVolumeUsage(id: string): Promise<{ usedBytes: number; totalBytes: number; availableBytes: number } | null> {
    const container = await this.findContainer(id);
    if (!container) return null;

    try {
      const info = await container.inspect();
      if (!info.State.Running) return null;

      const exec = await container.exec({
        Cmd: ["df", "-B1", "/data"],
        AttachStdout: true,
        AttachStderr: false,
      });

      const output = await new Promise<string>((resolve, reject) => {
        exec.start({}, (err: Error | null, stream: import("node:stream").Duplex | undefined) => {
          if (err) return reject(err);
          if (!stream) return reject(new Error("No stream from exec"));
          let data = "";
          stream.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          stream.on("end", () => resolve(data));
          stream.on("error", reject);
        });
      });

      // Parse df output — second line has the numbers
      const lines = output.trim().split("\n");
      if (lines.length < 2) return null;

      const parts = lines[lines.length - 1].split(/\s+/);
      if (parts.length < 4) return null;

      const totalBytes = parseInt(parts[1], 10);
      const usedBytes = parseInt(parts[2], 10);
      const availableBytes = parseInt(parts[3], 10);

      if (Number.isNaN(totalBytes) || Number.isNaN(usedBytes) || Number.isNaN(availableBytes)) return null;

      return { usedBytes, totalBytes, availableBytes };
    } catch {
      logger.warn(`Failed to get volume usage for bot ${id}`);
      return null;
    }
  }

  /** Get the underlying profile store */
  get profiles(): ProfileStore {
    return this.store;
  }

  // --- Private helpers ---

  private async pullImage(image: string): Promise<void> {
    logger.info(`Pulling image ${image}`);

    // Build authconfig from environment variables if present.
    // REGISTRY_USERNAME / REGISTRY_PASSWORD / REGISTRY_SERVER are optional;
    // when set they allow pulling from private registries (e.g. ghcr.io).
    const username = process.env.REGISTRY_USERNAME;
    const password = process.env.REGISTRY_PASSWORD;
    const server = process.env.REGISTRY_SERVER;
    const authconfig = username && password ? { username, password, serveraddress: server ?? "ghcr.io" } : undefined;

    const stream = await this.docker.pull(image, authconfig ? { authconfig } : {});
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async createContainer(
    profile: BotProfile,
    resourceLimits?: ContainerResourceLimits,
  ): Promise<Docker.Container> {
    const restartPolicyMap: Record<string, string> = {
      no: "no",
      always: "always",
      "on-failure": "on-failure",
      "unless-stopped": "unless-stopped",
    };

    const binds: string[] = [];
    if (profile.volumeName) {
      binds.push(`${profile.volumeName}:/data`);
    }

    const hostConfig: Docker.ContainerCreateOptions["HostConfig"] = {
      RestartPolicy: {
        Name: restartPolicyMap[profile.restartPolicy] || "",
      },
      Binds: binds.length > 0 ? binds : undefined,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      CapAdd: ["NET_BIND_SERVICE"],
      ReadonlyRootfs: true,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,size=64m",
        "/var/tmp": "rw,noexec,nosuid,size=64m",
      },
    };

    // Set tenant network isolation if NetworkPolicy is configured
    if (this.networkPolicy) {
      const networkMode = await this.networkPolicy.prepareForContainer(profile.tenantId);
      hostConfig.NetworkMode = networkMode;
    }

    // Apply resource limits from tier if provided
    if (resourceLimits) {
      hostConfig.Memory = resourceLimits.Memory;
      hostConfig.CpuQuota = resourceLimits.CpuQuota;
      hostConfig.PidsLimit = resourceLimits.PidsLimit;
    }

    // Merge discovery env vars into the container environment.
    // discoveryEnv overrides profile.env (spread order matters).
    // Empty-string values mean "explicitly remove" — filter them out.
    const discoveryEnv = buildDiscoveryEnv(profile.discovery, this.platformDiscovery);
    const mergedEnv = { ...profile.env, ...discoveryEnv };

    const container = await this.docker.createContainer({
      Image: profile.image,
      name: `wopr-${profile.name}`,
      Env: Object.entries(mergedEnv)
        .filter(([, v]) => v !== "")
        .map(([k, v]) => `${k}=${v}`),
      Labels: {
        [CONTAINER_LABEL]: "true",
        [CONTAINER_ID_LABEL]: profile.id,
      },
      HostConfig: hostConfig,
      Healthcheck: {
        Test: ["CMD-SHELL", "node -e 'process.exit(0)'"],
        Interval: 30_000_000_000, // 30s in nanoseconds
        Timeout: 10_000_000_000,
        Retries: 3,
        StartPeriod: 15_000_000_000,
      },
    });

    logger.info(`Created container ${container.id} for bot ${profile.id}`);
    return container;
  }

  private async findContainer(botId: string): Promise<Docker.Container | null> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [`${CONTAINER_ID_LABEL}=${botId}`],
      },
    });

    if (containers.length === 0) return null;
    return this.docker.getContainer(containers[0].Id);
  }

  private async statusForProfile(profile: BotProfile): Promise<BotStatus> {
    const container = await this.findContainer(profile.id);
    if (!container) return this.offlineStatus(profile);
    return this.buildStatus(profile, container);
  }

  private async buildStatus(profile: BotProfile, container: Docker.Container): Promise<BotStatus> {
    const info = await container.inspect();

    let stats: ContainerStats | null = null;
    if (info.State.Running) {
      try {
        stats = await this.getStats(container);
      } catch {
        // stats not available
      }
    }

    const now = new Date().toISOString();
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      image: profile.image,
      containerId: info.Id,
      state: info.State.Status as BotStatus["state"],
      health: info.State.Health?.Status ?? null,
      uptime: info.State.Running && info.State.StartedAt ? info.State.StartedAt : null,
      startedAt: info.State.StartedAt || null,
      createdAt: info.Created || now,
      updatedAt: now,
      stats,
    };
  }

  private offlineStatus(profile: BotProfile): BotStatus {
    const now = new Date().toISOString();
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      image: profile.image,
      containerId: null,
      state: "stopped",
      health: null,
      uptime: null,
      startedAt: null,
      createdAt: now,
      updatedAt: now,
      stats: null,
    };
  }

  private async getStats(container: Docker.Container): Promise<ContainerStats> {
    const raw = await container.stats({ stream: false });

    const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
    const systemDelta = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
    const numCpus = raw.cpu_stats.online_cpus || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

    const memUsage = raw.memory_stats.usage || 0;
    const memLimit = raw.memory_stats.limit || 1;

    return {
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryUsageMb: Math.round(memUsage / 1024 / 1024),
      memoryLimitMb: Math.round(memLimit / 1024 / 1024),
      memoryPercent: Math.round((memUsage / memLimit) * 100 * 100) / 100,
    };
  }
}

export class BotNotFoundError extends Error {
  constructor(id: string) {
    super(`Bot not found: ${id}`);
    this.name = "BotNotFoundError";
  }
}
