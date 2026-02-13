import type Docker from "dockerode";
import { logger } from "../config/logger.js";
import type { FleetManager } from "./fleet-manager.js";
import type { ImagePoller } from "./image-poller.js";
import type { ProfileStore } from "./profile-store.js";

/** How long to wait for a container to become healthy after update (ms) */
const HEALTH_CHECK_TIMEOUT_MS = 60_000;
/** How often to check container health during update verification (ms) */
const HEALTH_CHECK_POLL_MS = 5_000;

export interface UpdateResult {
  botId: string;
  success: boolean;
  previousImage: string;
  newImage: string;
  previousDigest: string | null;
  newDigest: string | null;
  rolledBack: boolean;
  error?: string;
}

/**
 * Handles container updates with rollback capability.
 * Orchestrates: pull new image -> stop -> recreate -> start -> verify -> cleanup.
 * On health check failure within timeout, rolls back to the previous image.
 */
export class ContainerUpdater {
  private readonly docker: Docker;
  private readonly store: ProfileStore;
  private readonly fleet: FleetManager;

  constructor(docker: Docker, store: ProfileStore, fleet: FleetManager, _poller: ImagePoller) {
    this.docker = docker;
    this.store = store;
    this.fleet = fleet;
  }

  /**
   * Update a bot's container to the latest image available for its release channel.
   * Rolls back if the new container fails health checks within 60s.
   */
  async updateBot(botId: string): Promise<UpdateResult> {
    const profile = await this.store.get(botId);
    if (!profile) {
      return {
        botId,
        success: false,
        previousImage: "",
        newImage: "",
        previousDigest: null,
        newDigest: null,
        rolledBack: false,
        error: "Bot not found",
      };
    }

    const previousImage = profile.image;
    let previousDigest: string | null = null;

    // Get the current container's digest before update
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`wopr.bot-id=${botId}`] },
      });
      if (containers.length > 0) {
        const container = this.docker.getContainer(containers[0].Id);
        const info = await container.inspect();
        previousDigest = info.Image ?? null;
      }
    } catch {
      // Non-fatal: we just won't have the previous digest
    }

    logger.info(`Starting update for bot ${botId} (image: ${previousImage})`);

    try {
      // Step 1: Pull the latest image
      logger.info(`Pulling latest image for bot ${botId}: ${profile.image}`);
      const pullStream = await this.docker.pull(profile.image);
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(pullStream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Step 2: Find and stop existing container
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`wopr.bot-id=${botId}`] },
      });

      let wasRunning = false;
      if (containers.length > 0) {
        const container = this.docker.getContainer(containers[0].Id);
        const info = await container.inspect();
        wasRunning = info.State.Running;

        if (wasRunning) {
          await container.stop();
        }
        await container.remove();
      }

      // Step 3: Recreate using FleetManager's update which handles container recreation
      // We use the fleet manager's restart flow to recreate with the same config
      // but we've already pulled and stopped, so we just need to recreate
      await this.fleet.update(botId, { image: profile.image });

      // Step 4: Start the new container if the old one was running
      if (wasRunning) {
        await this.fleet.start(botId);
      }

      // Step 5: Verify health
      const healthy = await this.waitForHealthy(botId);

      if (!healthy) {
        logger.warn(`Health check failed for bot ${botId} after update, rolling back`);
        return await this.rollback(botId, previousImage, previousDigest);
      }

      // Step 6: Get new digest for reporting
      let newDigest: string | null = null;
      try {
        const newContainers = await this.docker.listContainers({
          all: true,
          filters: { label: [`wopr.bot-id=${botId}`] },
        });
        if (newContainers.length > 0) {
          const c = this.docker.getContainer(newContainers[0].Id);
          const cInfo = await c.inspect();
          newDigest = cInfo.Image ?? null;
        }
      } catch {
        // Non-fatal
      }

      logger.info(`Successfully updated bot ${botId}`);
      return {
        botId,
        success: true,
        previousImage,
        newImage: profile.image,
        previousDigest,
        newDigest,
        rolledBack: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error(`Failed to update bot ${botId}: ${message}`, { err });

      // Attempt rollback
      try {
        return await this.rollback(botId, previousImage, previousDigest);
      } catch (rollbackErr) {
        logger.error(`Rollback also failed for bot ${botId}`, { rollbackErr });
        return {
          botId,
          success: false,
          previousImage,
          newImage: profile.image,
          previousDigest,
          newDigest: null,
          rolledBack: false,
          error: `Update failed: ${message}. Rollback also failed.`,
        };
      }
    }
  }

  /**
   * Wait for a bot's container to become healthy within the timeout.
   */
  private async waitForHealthy(botId: string): Promise<boolean> {
    const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const containers = await this.docker.listContainers({
          all: true,
          filters: { label: [`wopr.bot-id=${botId}`] },
        });

        if (containers.length > 0) {
          const container = this.docker.getContainer(containers[0].Id);
          const info = await container.inspect();

          if (info.State.Running) {
            // If no healthcheck configured, running is enough
            if (!info.State.Health) return true;
            if (info.State.Health.Status === "healthy") return true;
            if (info.State.Health.Status === "unhealthy") return false;
            // "starting" — keep waiting
          }
        }
      } catch {
        // Container might be in transition, keep waiting
      }

      await sleep(HEALTH_CHECK_POLL_MS);
    }

    return false;
  }

  /**
   * Roll back to a previous image by updating the bot profile and recreating.
   */
  private async rollback(botId: string, previousImage: string, previousDigest: string | null): Promise<UpdateResult> {
    logger.info(`Rolling back bot ${botId} to ${previousImage}`);

    try {
      await this.fleet.update(botId, { image: previousImage });
      await this.fleet.start(botId).catch(() => {
        // May already be running or not exist
      });

      return {
        botId,
        success: false,
        previousImage,
        newImage: previousImage,
        previousDigest,
        newDigest: previousDigest,
        rolledBack: true,
        error: "Health check failed after update, rolled back to previous image",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new Error(`Rollback failed: ${message}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
