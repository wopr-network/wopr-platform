import type Docker from "dockerode";
import { logger } from "../config/logger.js";
import type { FleetManager } from "./fleet-manager.js";
import { getContainerDigest } from "./image-poller.js";
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
 * Orchestrates: pull new image -> delegate recreation to FleetManager -> start -> verify health.
 * On health check failure within timeout, rolls back to the previous image.
 */
export class ContainerUpdater {
  private readonly docker: Docker;
  private readonly store: ProfileStore;
  private readonly fleet: FleetManager;
  /** Per-bot lock to prevent concurrent updates to the same bot. */
  private readonly updating = new Set<string>();

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
    if (this.updating.has(botId)) {
      return {
        botId,
        success: false,
        previousImage: "",
        newImage: "",
        previousDigest: null,
        newDigest: null,
        rolledBack: false,
        error: "Update already in progress",
      };
    }

    this.updating.add(botId);
    try {
      return await this.doUpdateBot(botId);
    } finally {
      this.updating.delete(botId);
    }
  }

  private async doUpdateBot(botId: string): Promise<UpdateResult> {
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

    // Get the current container's manifest digest before update.
    // Uses RepoDigests (manifest digest) instead of container config digest
    // so it can be compared consistently with registry digests.
    try {
      previousDigest = await getContainerDigest(this.docker, botId);
    } catch {
      // Non-fatal: we just won't have the previous digest
    }

    logger.info(`Starting update for bot ${botId} (image: ${previousImage})`);

    // Track whether the old container was running so rollback preserves original state
    let wasRunning = false;
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`wopr.bot-id=${botId}`] },
      });
      if (containers.length > 0) {
        const container = this.docker.getContainer(containers[0].Id);
        const info = await container.inspect();
        wasRunning = info.State.Running;
      }
    } catch {
      // Non-fatal: assume stopped if we can't determine state
    }

    try {
      // Step 1: Pull the latest image before touching the running container.
      // If the pull fails, the old container is untouched.
      logger.info(`Pulling latest image for bot ${botId}: ${profile.image}`);
      const pullStream = await this.docker.pull(profile.image);
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(pullStream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Step 2: Delegate stop -> remove -> recreate to FleetManager.update().
      // fleet.update() already implements: stop old -> remove old -> create new,
      // with profile rollback if container creation fails.
      await this.fleet.update(botId, { image: profile.image });

      // Step 3: Start the new container only if the old one was running
      if (wasRunning) {
        await this.fleet.start(botId);
      }

      // Step 4: Verify health (only meaningful if container is running)
      if (wasRunning) {
        const healthy = await this.waitForHealthy(botId);

        if (!healthy) {
          logger.warn(`Health check failed for bot ${botId} after update, rolling back`);
          return await this.rollback(botId, previousImage, previousDigest, wasRunning);
        }
      }

      // Step 5: Get new digest for reporting using manifest digest (RepoDigests)
      let newDigest: string | null = null;
      try {
        newDigest = await getContainerDigest(this.docker, botId);
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
        return await this.rollback(botId, previousImage, previousDigest, wasRunning);
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
            if (!info.State.Health) {
              logger.warn(`Container for bot ${botId} has no HEALTHCHECK configured, assuming healthy`);
              return true;
            }
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
   * Only starts the container on rollback if it was running before the update.
   */
  private async rollback(
    botId: string,
    previousImage: string,
    previousDigest: string | null,
    wasRunning: boolean,
  ): Promise<UpdateResult> {
    logger.info(`Rolling back bot ${botId} to ${previousImage}`);

    try {
      await this.fleet.update(botId, { image: previousImage });

      // Only start on rollback if the container was running before the update
      if (wasRunning) {
        await this.fleet.start(botId).catch((err) => {
          logger.warn(`Failed to start bot ${botId} during rollback (may already be running)`, { err });
        });
      }

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
