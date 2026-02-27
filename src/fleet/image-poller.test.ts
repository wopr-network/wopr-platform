import type Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "./fleet-manager.js";
import { getContainerDigest, ImagePoller, parseImageRef } from "./image-poller.js";
import type { ProfileStore } from "./profile-store.js";
import type { BotProfile } from "./types.js";
import { ContainerUpdater } from "./updater.js";

// --- Mock helpers ---

function makeProfile(overrides: Partial<BotProfile> = {}): BotProfile {
  return {
    id: "bot-1",
    tenantId: "user-123",
    name: "test-bot",
    description: "A test bot",
    image: "ghcr.io/wopr-network/wopr:stable",
    env: {},
    restartPolicy: "unless-stopped",
    releaseChannel: "stable",
    updatePolicy: "manual",
    ...overrides,
  };
}

function mockStore(profiles: BotProfile[] = []): ProfileStore {
  const map = new Map(profiles.map((p) => [p.id, p]));
  return {
    init: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockImplementation(async (p: BotProfile) => {
      map.set(p.id, p);
    }),
    get: vi.fn().mockImplementation(async (id: string) => map.get(id) ?? null),
    list: vi.fn().mockImplementation(async () => [...map.values()]),
    delete: vi.fn().mockImplementation(async (id: string) => map.delete(id)),
    dataDir: "/tmp/test-fleet",
  } as unknown as ProfileStore;
}

function mockContainer(overrides: Record<string, unknown> = {}) {
  return {
    id: "container-123",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      Id: "container-123",
      Image: "sha256:abc123",
      Created: "2026-01-01T00:00:00Z",
      State: {
        Status: "running",
        Running: true,
        StartedAt: "2026-01-01T00:00:00Z",
        Health: { Status: "healthy" },
      },
    }),
    stats: vi.fn().mockResolvedValue({
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 104857600, limit: 1073741824 },
    }),
    logs: vi.fn().mockResolvedValue(Buffer.from("log")),
    ...overrides,
  };
}

function mockDocker(container: ReturnType<typeof mockContainer> | null = null) {
  return {
    pull: vi.fn().mockResolvedValue("stream"),
    createContainer: vi.fn().mockResolvedValue(container ?? mockContainer()),
    listContainers: vi.fn().mockResolvedValue(container ? [{ Id: "container-123" }] : []),
    getContainer: vi.fn().mockReturnValue(container),
    getImage: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ RepoDigests: ["ghcr.io/wopr-network/wopr@sha256:abc123"] }),
    }),
    modem: {
      followProgress: vi.fn((_stream: unknown, cb: (err: Error | null) => void) => cb(null)),
    },
  };
}

// --- Tests ---

describe("parseImageRef", () => {
  it("parses ghcr.io/owner/repo:tag", () => {
    const ref = parseImageRef("ghcr.io/wopr-network/wopr:stable");
    expect(ref).toEqual({
      registry: "ghcr.io",
      owner: "wopr-network",
      repo: "wopr",
      tag: "stable",
    });
  });

  it("parses image with no tag as latest", () => {
    const ref = parseImageRef("ghcr.io/wopr-network/wopr");
    expect(ref).toEqual({
      registry: "ghcr.io",
      owner: "wopr-network",
      repo: "wopr",
      tag: "latest",
    });
  });

  it("parses canary tag", () => {
    const ref = parseImageRef("ghcr.io/wopr-network/wopr:latest");
    expect(ref).toEqual({
      registry: "ghcr.io",
      owner: "wopr-network",
      repo: "wopr",
      tag: "latest",
    });
  });

  it("parses pinned version tag", () => {
    const ref = parseImageRef("ghcr.io/wopr-network/wopr:v1.2.3");
    expect(ref).toEqual({
      registry: "ghcr.io",
      owner: "wopr-network",
      repo: "wopr",
      tag: "v1.2.3",
    });
  });

  it("handles nested repo path", () => {
    const ref = parseImageRef("ghcr.io/org/sub/repo:latest");
    expect(ref).toEqual({
      registry: "ghcr.io",
      owner: "org",
      repo: "sub/repo",
      tag: "latest",
    });
  });

  it("handles single-segment image name without registry", () => {
    const ref = parseImageRef("myimage:v1");
    expect(ref.registry).toBe("ghcr.io");
    expect(ref.owner).toBe("myimage");
    expect(ref.repo).toBe("myimage");
    expect(ref.tag).toBe("v1");
  });

  it("handles image without a dot in first segment (no registry prefix)", () => {
    // "wopr-network/wopr:stable" — first segment has no dot, so treated as owner/repo
    const ref = parseImageRef("wopr-network/wopr:stable");
    expect(ref.registry).toBe("ghcr.io");
    expect(ref.owner).toBe("wopr-network");
    expect(ref.repo).toBe("wopr");
    expect(ref.tag).toBe("stable");
  });
});

describe("ImagePoller", () => {
  let docker: ReturnType<typeof mockDocker>;
  let store: ProfileStore;
  let container: ReturnType<typeof mockContainer>;
  let poller: ImagePoller;

  beforeEach(() => {
    container = mockContainer();
    docker = mockDocker(container);
    store = mockStore([makeProfile()]);
    poller = new ImagePoller(docker as unknown as Docker, store);
  });

  afterEach(() => {
    poller.stop();
    vi.restoreAllMocks();
  });

  describe("trackBot", () => {
    it("skips pinned bots", () => {
      const pinnedProfile = makeProfile({ id: "pinned-bot", releaseChannel: "pinned" });
      poller.trackBot(pinnedProfile);
      const status = poller.getImageStatus("pinned-bot", pinnedProfile);
      expect(status.lastCheckedAt).toBeNull();
    });

    it("tracks canary bots", () => {
      const canaryProfile = makeProfile({
        id: "canary-bot",
        releaseChannel: "canary",
        image: "ghcr.io/wopr-network/wopr:latest",
      });
      // Mock the fetch calls that checkBot will make
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-token" }) })
          .mockResolvedValueOnce({ ok: true, headers: new Headers({ "docker-content-digest": "sha256:new123" }) }),
      );
      poller.trackBot(canaryProfile);
      // The bot should be tracked (timer created)
      const status = poller.getImageStatus("canary-bot", canaryProfile);
      expect(status.releaseChannel).toBe("canary");
      vi.unstubAllGlobals();
    });
  });

  describe("untrackBot", () => {
    it("removes a bot from tracking", () => {
      const profile = makeProfile();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-token" }) })
          .mockResolvedValueOnce({ ok: true, headers: new Headers({ "docker-content-digest": "sha256:new123" }) }),
      );
      poller.trackBot(profile);
      poller.untrackBot(profile.id);
      const status = poller.getImageStatus(profile.id, profile);
      // After untracking, tracked map entry is removed
      expect(status.currentDigest).toBeNull();
      expect(status.availableDigest).toBeNull();
      vi.unstubAllGlobals();
    });
  });

  describe("getImageStatus", () => {
    it("returns default status for untracked bot", () => {
      const profile = makeProfile({ id: "new-bot" });
      const status = poller.getImageStatus("new-bot", profile);
      expect(status).toEqual({
        botId: "new-bot",
        currentDigest: null,
        availableDigest: null,
        updateAvailable: false,
        releaseChannel: "stable",
        updatePolicy: "manual",
        lastCheckedAt: null,
      });
    });
  });

  describe("checkBot", () => {
    it("detects when update is available", async () => {
      const profile = makeProfile();

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-token" }) })
          .mockResolvedValueOnce({ ok: true, headers: new Headers({ "docker-content-digest": "sha256:new999" }) }),
      );

      // Mock container inspect returns sha256:abc123 (different from sha256:new999)
      poller.trackBot(profile);
      // Wait for initial check
      await vi.waitFor(() => {
        const status = poller.getImageStatus(profile.id, profile);
        expect(status.lastCheckedAt).not.toBeNull();
      });

      const status = poller.getImageStatus(profile.id, profile);
      expect(status.availableDigest).toBe("sha256:new999");
      expect(status.currentDigest).toBe("sha256:abc123");
      expect(status.updateAvailable).toBe(true);

      vi.unstubAllGlobals();
    });

    it("detects when no update is available", async () => {
      const profile = makeProfile();

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-token" }) })
          .mockResolvedValueOnce({ ok: true, headers: new Headers({ "docker-content-digest": "sha256:abc123" }) }),
      );

      // Make container inspect return same digest
      poller.trackBot(profile);
      await vi.waitFor(() => {
        const status = poller.getImageStatus(profile.id, profile);
        expect(status.lastCheckedAt).not.toBeNull();
      });

      const status = poller.getImageStatus(profile.id, profile);
      expect(status.updateAvailable).toBe(false);

      vi.unstubAllGlobals();
    });

    it("calls onUpdateAvailable for on-push policy when update detected", async () => {
      const profile = makeProfile({ updatePolicy: "on-push" });
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      poller.onUpdateAvailable = onUpdate;

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-token" }) })
          .mockResolvedValueOnce({ ok: true, headers: new Headers({ "docker-content-digest": "sha256:new999" }) }),
      );

      // Re-create store with the on-push profile
      store = mockStore([profile]);
      poller = new ImagePoller(docker as unknown as Docker, store);
      poller.onUpdateAvailable = onUpdate;
      poller.trackBot(profile);

      await vi.waitFor(() => {
        expect(onUpdate).toHaveBeenCalledWith(profile.id, "sha256:new999");
      });

      vi.unstubAllGlobals();
    });

    it("does not call onUpdateAvailable for manual policy", async () => {
      const profile = makeProfile({ updatePolicy: "manual" });
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      poller.onUpdateAvailable = onUpdate;

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-token" }) })
          .mockResolvedValueOnce({ ok: true, headers: new Headers({ "docker-content-digest": "sha256:new999" }) }),
      );

      poller.trackBot(profile);
      await vi.waitFor(() => {
        const status = poller.getImageStatus(profile.id, profile);
        expect(status.lastCheckedAt).not.toBeNull();
      });

      expect(onUpdate).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("handles GHCR fetch errors gracefully", async () => {
      const profile = makeProfile();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" }),
      );

      poller.trackBot(profile);
      // Wait a bit for the check to complete (should not throw)
      await new Promise((r) => setTimeout(r, 100));

      const status = poller.getImageStatus(profile.id, profile);
      // Should have tracking entry but no digest info due to error
      expect(status.currentDigest).toBeNull();
      vi.unstubAllGlobals();
    });
  });

  describe("POLL_INTERVALS", () => {
    it("has correct intervals per channel", () => {
      expect(ImagePoller.POLL_INTERVALS.canary).toBe(5 * 60 * 1000);
      expect(ImagePoller.POLL_INTERVALS.staging).toBe(15 * 60 * 1000);
      expect(ImagePoller.POLL_INTERVALS.stable).toBe(30 * 60 * 1000);
      expect(ImagePoller.POLL_INTERVALS.pinned).toBe(0);
    });
  });

  describe("shouldAutoUpdate — nightly and cron policies", () => {
    it("does not call onUpdateAvailable for nightly policy outside the nightly window", async () => {
      // Pin clock to 10:00 UTC — well outside the 03:00-03:05 nightly window.
      vi.useFakeTimers({ now: new Date("2025-01-01T10:00:00.000Z"), shouldAdvanceTime: false });
      const profile = makeProfile({ updatePolicy: "nightly" });
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      poller.onUpdateAvailable = onUpdate;

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-token" }) })
          .mockResolvedValueOnce({ ok: true, headers: new Headers({ "docker-content-digest": "sha256:new999" }) }),
      );

      poller.trackBot(profile);
      await vi.waitFor(() => {
        const status = poller.getImageStatus(profile.id, profile);
        expect(status.lastCheckedAt).not.toBeNull();
      });

      // onUpdate should not be called since we're not in the nightly window
      expect(onUpdate).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("does not call onUpdateAvailable for cron: policy", async () => {
      const profile = makeProfile({ updatePolicy: "cron:0 3 * * *" });
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      poller.onUpdateAvailable = onUpdate;

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "test-token" }) })
          .mockResolvedValueOnce({ ok: true, headers: new Headers({ "docker-content-digest": "sha256:new999" }) }),
      );

      poller.trackBot(profile);
      await vi.waitFor(() => {
        const status = poller.getImageStatus(profile.id, profile);
        expect(status.lastCheckedAt).not.toBeNull();
      });

      expect(onUpdate).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  describe("start", () => {
    it("does not re-initialize when called twice", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "test-token" }) }));

      await poller.start();
      // Second call should be a no-op
      await poller.start();

      // store.list should only have been called once
      expect(store.list).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });
  });

  describe("trackBot — re-tracking clears existing timer", () => {
    it("replaces existing timer when bot is re-tracked", () => {
      const profile = makeProfile({
        id: "stable-bot",
        releaseChannel: "stable",
        image: "ghcr.io/wopr-network/wopr:stable",
      });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: "test-token" }) }));

      poller.trackBot(profile);
      // Re-tracking should clear the old timer and create a new one
      poller.trackBot(profile);

      const status = poller.getImageStatus(profile.id, profile);
      expect(status.releaseChannel).toBe("stable");
      vi.unstubAllGlobals();
    });
  });
});

describe("getContainerDigest", () => {
  it("returns digest from container inspect", async () => {
    const container = mockContainer();
    const docker = mockDocker(container);

    const digest = await getContainerDigest(docker as unknown as Docker, "bot-1");
    expect(digest).toBe("sha256:abc123");
  });

  it("returns null when no container found", async () => {
    const docker = mockDocker(null);
    docker.listContainers.mockResolvedValue([]);

    const digest = await getContainerDigest(docker as unknown as Docker, "missing");
    expect(digest).toBeNull();
  });

  it("returns null when RepoDigests is empty", async () => {
    const container = mockContainer({
      inspect: vi.fn().mockResolvedValue({ Id: "c1", Image: "sha256:cfgdigest" }),
    });
    const docker = {
      ...mockDocker(container),
      getImage: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ RepoDigests: [] }),
      }),
    };
    docker.listContainers.mockResolvedValue([{ Id: "c1" }]);

    const digest = await getContainerDigest(docker as unknown as Docker, "bot-1");
    expect(digest).toBeNull();
  });

  it("returns null when RepoDigests entry has no @ character", async () => {
    const container = mockContainer({
      inspect: vi.fn().mockResolvedValue({ Id: "c1", Image: "sha256:cfgdigest" }),
    });
    const docker = {
      ...mockDocker(container),
      getImage: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ RepoDigests: ["noatsignhere"] }),
      }),
    };
    docker.listContainers.mockResolvedValue([{ Id: "c1" }]);

    const digest = await getContainerDigest(docker as unknown as Docker, "bot-1");
    expect(digest).toBeNull();
  });
});

describe("ContainerUpdater", () => {
  let docker: ReturnType<typeof mockDocker>;
  let store: ProfileStore;
  let container: ReturnType<typeof mockContainer>;
  let fleet: FleetManager;
  let poller: ImagePoller;
  let updater: ContainerUpdater;

  beforeEach(() => {
    container = mockContainer();
    docker = mockDocker(container);
    store = mockStore([makeProfile()]);
    fleet = new FleetManager(docker as unknown as Docker, store);
    poller = new ImagePoller(docker as unknown as Docker, store);
    updater = new ContainerUpdater(docker as unknown as Docker, store, fleet, poller);
  });

  afterEach(() => {
    poller.stop();
    vi.restoreAllMocks();
  });

  it("returns error for missing bot", async () => {
    const result = await updater.updateBot("nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Bot not found");
  });

  it("performs update by pulling, stopping, and recreating", async () => {
    // The fleet.update method will be called to recreate the container
    // We need to make sure listContainers returns properly
    docker.listContainers
      .mockResolvedValueOnce([{ Id: "container-123" }]) // getContainerDigest during updateBot
      .mockResolvedValueOnce([{ Id: "container-123" }]) // step 2: find container to stop
      .mockResolvedValueOnce([{ Id: "container-123" }]) // fleet.update -> findContainer
      .mockResolvedValueOnce([{ Id: "container-123" }]) // fleet.update -> findContainer after recreate
      .mockResolvedValueOnce([{ Id: "container-123" }]) // fleet.start -> findContainer
      .mockResolvedValueOnce([{ Id: "container-123" }]); // waitForHealthy

    docker.getContainer.mockReturnValue(container);

    const result = await updater.updateBot("bot-1");
    expect(result.success).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(docker.pull).toHaveBeenCalled();
  });

  it("rejects concurrent updates to the same bot", async () => {
    // Make the first update take a while by making pull hang
    let resolvePull: ((err: Error | null) => void) | null = null;
    docker.modem.followProgress.mockImplementationOnce((_stream: unknown, cb: (err: Error | null) => void) => {
      resolvePull = cb;
    });

    docker.listContainers
      .mockResolvedValueOnce([{ Id: "container-123" }]) // first update: getContainerDigest
      .mockResolvedValueOnce([{ Id: "container-123" }]) // first update: step 2
      .mockResolvedValueOnce([{ Id: "container-123" }]) // fleet.update
      .mockResolvedValueOnce([{ Id: "container-123" }]) // fleet.start
      .mockResolvedValueOnce([{ Id: "container-123" }]) // waitForHealthy
      .mockResolvedValueOnce([{ Id: "container-123" }]); // get new digest

    docker.getContainer.mockReturnValue(container);

    // Start first update (will block on pull)
    const first = updater.updateBot("bot-1");

    // Wait for the pull to be called so the lock is held
    await vi.waitFor(() => {
      expect(resolvePull).not.toBeNull();
    });

    // Second call should fail immediately with lock error
    const second = await updater.updateBot("bot-1");
    expect(second.success).toBe(false);
    expect(second.error).toBe("Update already in progress");

    // Unblock first update and let it complete
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by waitFor above
    resolvePull!(null);
    const firstResult = await first;
    expect(firstResult.success).toBe(true);
  });

  it("rolls back when health check returns unhealthy", async () => {
    const unhealthyContainer = mockContainer({
      inspect: vi.fn().mockResolvedValue({
        Id: "container-123",
        Image: "sha256:new999",
        Created: "2026-01-01T00:00:00Z",
        State: {
          Status: "running",
          Running: true,
          StartedAt: "2026-01-01T00:00:00Z",
          Health: { Status: "unhealthy" },
        },
      }),
    });

    // Make the new container unhealthy so rollback happens
    docker.listContainers
      .mockResolvedValueOnce([{ Id: "container-123" }]) // getContainerDigest
      .mockResolvedValueOnce([{ Id: "container-123" }]) // step 2: find container to stop
      .mockResolvedValueOnce([]) // fleet.update -> findContainer (no existing)
      .mockResolvedValueOnce([{ Id: "container-123" }]) // fleet.start
      .mockResolvedValueOnce([{ Id: "container-123" }]) // waitForHealthy
      .mockResolvedValueOnce([]) // rollback fleet.update -> findContainer
      .mockResolvedValueOnce([{ Id: "container-123" }]); // rollback fleet.start

    docker.getContainer
      .mockReturnValueOnce(container) // getContainerDigest inspect
      .mockReturnValueOnce(container) // step 2: stop + remove
      .mockReturnValueOnce(container) // fleet.start
      .mockReturnValueOnce(unhealthyContainer) // waitForHealthy inspect
      .mockReturnValueOnce(container); // rollback fleet.start

    const result = await updater.updateBot("bot-1");
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
  });
});
