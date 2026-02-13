import type Docker from "dockerode";
import { logger } from "../config/logger.js";
import type { ProfileStore } from "./profile-store.js";
import type { BotProfile, ImageStatus, ReleaseChannel } from "./types.js";

/** GHCR registry base URL for token and manifest requests */
const GHCR_AUTH_URL = "https://ghcr.io/token";
const GHCR_REGISTRY_URL = "https://ghcr.io/v2";

/** Default poll intervals per release channel (milliseconds) */
const POLL_INTERVALS: Record<ReleaseChannel, number> = {
  canary: 5 * 60 * 1000, // 5 minutes
  staging: 15 * 60 * 1000, // 15 minutes
  stable: 30 * 60 * 1000, // 30 minutes
  pinned: 0, // Never
};

/** Parsed image reference */
interface ImageRef {
  registry: string;
  owner: string;
  repo: string;
  tag: string;
}

/** Tracked state for a single bot's image */
interface TrackedBot {
  botId: string;
  currentDigest: string | null;
  availableDigest: string | null;
  lastCheckedAt: string | null;
}

/**
 * Fetches an anonymous GHCR bearer token for the given image scope.
 */
export async function fetchGhcrToken(owner: string, repo: string): Promise<string> {
  const scope = `repository:${owner}/${repo}:pull`;
  const url = `${GHCR_AUTH_URL}?scope=${encodeURIComponent(scope)}&service=ghcr.io`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch GHCR token: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

/**
 * Fetches the latest image digest from GHCR for a given image reference.
 */
export async function fetchRemoteDigest(imageRef: ImageRef): Promise<string> {
  const token = await fetchGhcrToken(imageRef.owner, imageRef.repo);
  const url = `${GHCR_REGISTRY_URL}/${imageRef.owner}/${imageRef.repo}/manifests/${imageRef.tag}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch manifest for ${imageRef.owner}/${imageRef.repo}:${imageRef.tag}: ${res.status}`);
  }

  const digest = res.headers.get("docker-content-digest");
  if (!digest) {
    throw new Error(`No digest header for ${imageRef.owner}/${imageRef.repo}:${imageRef.tag}`);
  }
  return digest;
}

/**
 * Parses a Docker image string into its components.
 * Handles ghcr.io/owner/repo:tag format.
 */
export function parseImageRef(image: string): ImageRef {
  // Default registry/tag
  let registry = "ghcr.io";
  let rest = image;

  // Check if image starts with a registry
  if (rest.includes("/") && rest.split("/")[0].includes(".")) {
    const slashIdx = rest.indexOf("/");
    registry = rest.substring(0, slashIdx);
    rest = rest.substring(slashIdx + 1);
  }

  // Split tag
  const colonIdx = rest.lastIndexOf(":");
  let tag = "latest";
  let path = rest;
  if (colonIdx !== -1) {
    tag = rest.substring(colonIdx + 1);
    path = rest.substring(0, colonIdx);
  }

  // Split owner/repo
  const parts = path.split("/");
  if (parts.length < 2) {
    return { registry, owner: parts[0], repo: parts[0], tag };
  }
  return { registry, owner: parts[0], repo: parts.slice(1).join("/"), tag };
}

/**
 * Gets the current running image digest for a bot's container.
 */
export async function getContainerDigest(docker: Docker, botId: string): Promise<string | null> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`wopr.bot-id=${botId}`] },
  });

  if (containers.length === 0) return null;

  const container = docker.getContainer(containers[0].Id);
  const info = await container.inspect();

  // Docker stores the image digest in the Image field as sha256:...
  // or in RepoDigests
  if (info.Image && info.Image.startsWith("sha256:")) {
    return info.Image;
  }

  // Try RepoDigests
  const imageInfo = await docker.getImage(info.Image).inspect();
  if (imageInfo.RepoDigests && imageInfo.RepoDigests.length > 0) {
    const digest = imageInfo.RepoDigests[0];
    const atIdx = digest.indexOf("@");
    if (atIdx !== -1) return digest.substring(atIdx + 1);
  }

  return null;
}

/**
 * ImagePoller watches GHCR for new image digests and tracks update availability.
 */
export class ImagePoller {
  private readonly docker: Docker;
  private readonly store: ProfileStore;
  private readonly tracked = new Map<string, TrackedBot>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;

  /** Injected callback for when an update is available and should be applied */
  onUpdateAvailable: ((botId: string, newDigest: string) => Promise<void>) | null = null;

  constructor(docker: Docker, store: ProfileStore) {
    this.docker = docker;
    this.store = store;
  }

  /**
   * Start polling for all bots in the store.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const profiles = await this.store.list();
    for (const profile of profiles) {
      this.trackBot(profile);
    }
    logger.info(`Image poller started, tracking ${profiles.length} bots`);
  }

  /**
   * Stop all polling timers.
   */
  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    logger.info("Image poller stopped");
  }

  /**
   * Start tracking a bot for image updates.
   */
  trackBot(profile: BotProfile): void {
    // Don't poll pinned bots
    if (profile.releaseChannel === "pinned") {
      logger.debug(`Skipping pinned bot ${profile.id}`);
      return;
    }

    const interval = POLL_INTERVALS[profile.releaseChannel];
    if (interval <= 0) return;

    // Initialize tracking state
    this.tracked.set(profile.id, {
      botId: profile.id,
      currentDigest: null,
      availableDigest: null,
      lastCheckedAt: null,
    });

    // Clear any existing timer
    const existing = this.timers.get(profile.id);
    if (existing) clearInterval(existing);

    // Run initial check, then schedule recurring
    void this.checkBot(profile);
    const timer = setInterval(() => void this.checkBot(profile), interval);
    this.timers.set(profile.id, timer);
  }

  /**
   * Stop tracking a specific bot.
   */
  untrackBot(botId: string): void {
    const timer = this.timers.get(botId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(botId);
    }
    this.tracked.delete(botId);
  }

  /**
   * Check a single bot for image updates.
   */
  async checkBot(profile: BotProfile): Promise<void> {
    const tracking = this.tracked.get(profile.id);
    if (!tracking) return;

    try {
      const imageRef = parseImageRef(profile.image);
      const [remoteDigest, currentDigest] = await Promise.all([
        fetchRemoteDigest(imageRef),
        getContainerDigest(this.docker, profile.id),
      ]);

      tracking.currentDigest = currentDigest;
      tracking.availableDigest = remoteDigest;
      tracking.lastCheckedAt = new Date().toISOString();

      if (currentDigest && remoteDigest !== currentDigest) {
        logger.info(`New image available for bot ${profile.id}: ${remoteDigest} (current: ${currentDigest})`);

        if (this.shouldAutoUpdate(profile) && this.onUpdateAvailable) {
          await this.onUpdateAvailable(profile.id, remoteDigest);
        }
      }
    } catch (err) {
      logger.error(`Failed to check image for bot ${profile.id}`, { err });
    }
  }

  /**
   * Force check a specific bot by ID (re-reads profile from store).
   */
  async forceCheck(botId: string): Promise<ImageStatus | null> {
    const profile = await this.store.get(botId);
    if (!profile) return null;

    await this.checkBot(profile);
    return this.getImageStatus(botId, profile);
  }

  /**
   * Get the image status for a bot.
   */
  getImageStatus(botId: string, profile: BotProfile): ImageStatus {
    const tracking = this.tracked.get(botId);
    return {
      botId,
      currentDigest: tracking?.currentDigest ?? null,
      availableDigest: tracking?.availableDigest ?? null,
      updateAvailable: tracking != null && tracking.currentDigest != null && tracking.availableDigest != null && tracking.currentDigest !== tracking.availableDigest,
      releaseChannel: profile.releaseChannel,
      updatePolicy: profile.updatePolicy,
      lastCheckedAt: tracking?.lastCheckedAt ?? null,
    };
  }

  /**
   * Determine if a bot should auto-update based on its policy.
   */
  private shouldAutoUpdate(profile: BotProfile): boolean {
    switch (profile.updatePolicy) {
      case "on-push":
        return true;
      case "nightly":
        return this.isNightlyWindow();
      case "manual":
        return false;
      default:
        // cron:<expression> — for now, treat as manual until cron scheduler is added
        if (profile.updatePolicy.startsWith("cron:")) {
          return false;
        }
        return false;
    }
  }

  /**
   * Check if we're within the nightly update window (03:00-03:05 UTC).
   */
  private isNightlyWindow(): boolean {
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    return hour === 3 && minute < 5;
  }

  /** Expose poll intervals for testing */
  static readonly POLL_INTERVALS = POLL_INTERVALS;
}
