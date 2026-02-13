import { randomUUID } from "node:crypto";
import type Docker from "dockerode";
import { logger } from "../config/logger.js";
import type { ProfileStore } from "./profile-store.js";
import type { BotProfile, BotStatus, ContainerStats } from "./types.js";

const CONTAINER_LABEL = "wopr.managed";
const CONTAINER_ID_LABEL = "wopr.bot-id";

export class FleetManager {
  private readonly docker: Docker;
  private readonly store: ProfileStore;

  constructor(docker: Docker, store: ProfileStore) {
    this.docker = docker;
    this.store = store;
  }

  /**
   * Create a new bot: persist profile, pull image, create container.
   * Rolls back profile on container creation failure.
   */
  async create(params: Omit<BotProfile, "id">): Promise<BotProfile> {
    const profile: BotProfile = { id: randomUUID(), ...params };

    await this.store.save(profile);

    try {
      await this.pullImage(profile.image);
      await this.createContainer(profile);
    } catch (err) {
      logger.error(`Failed to create container for bot ${profile.id}, rolling back profile`, { err });
      await this.store.delete(profile.id);
      throw err;
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
    logger.info(`Started bot ${id}`);
  }

  /**
   * Stop a running bot container.
   */
  async stop(id: string): Promise<void> {
    const container = await this.findContainer(id);
    if (!container) throw new BotNotFoundError(id);
    await container.stop();
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
    const container = await this.findContainer(id);
    if (container) {
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop();
      }
      await container.remove({ v: removeVolumes });
    }
    await this.store.delete(id);
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

  /**
   * Update a bot profile. If the bot is running, restart it to apply changes.
   */
  async update(id: string, updates: Partial<Omit<BotProfile, "id">>): Promise<BotProfile> {
    const existing = await this.store.get(id);
    if (!existing) throw new BotNotFoundError(id);

    const updated: BotProfile = { ...existing, ...updates };
    await this.store.save(updated);

    // If image changed and container exists, recreate
    const container = await this.findContainer(id);
    if (container) {
      const info = await container.inspect();
      const wasRunning = info.State.Running;

      if (updates.image) {
        await this.pullImage(updated.image);
      }

      await container.stop().catch(() => {});
      await container.remove().catch(() => {});
      await this.createContainer(updated);

      if (wasRunning) {
        const newContainer = await this.findContainer(id);
        if (newContainer) await newContainer.start();
      }
    }

    return updated;
  }

  /** Get the underlying profile store */
  get profiles(): ProfileStore {
    return this.store;
  }

  // --- Private helpers ---

  private async pullImage(image: string): Promise<void> {
    logger.info(`Pulling image ${image}`);
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async createContainer(profile: BotProfile): Promise<Docker.Container> {
    const restartPolicyMap: Record<string, string> = {
      no: "",
      always: "always",
      "on-failure": "on-failure",
      "unless-stopped": "unless-stopped",
    };

    const binds: string[] = [];
    if (profile.volumeName) {
      binds.push(`${profile.volumeName}:/data`);
    }

    const container = await this.docker.createContainer({
      Image: profile.image,
      name: `wopr-${profile.name}`,
      Env: Object.entries(profile.env).map(([k, v]) => `${k}=${v}`),
      Labels: {
        [CONTAINER_LABEL]: "true",
        [CONTAINER_ID_LABEL]: profile.id,
      },
      HostConfig: {
        RestartPolicy: {
          Name: restartPolicyMap[profile.restartPolicy] || "",
        },
        Binds: binds.length > 0 ? binds : undefined,
      },
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
