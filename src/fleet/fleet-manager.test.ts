import type Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkPolicy } from "../network/network-policy.js";
import { BotNotFoundError, FleetManager } from "./fleet-manager.js";
import type { ProfileStore } from "./profile-store.js";
import type { BotProfile } from "./types.js";

// --- Mock helpers ---

function mockContainer(overrides: Record<string, unknown> = {}) {
  return {
    id: "container-123",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      Id: "container-123",
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
    logs: vi.fn().mockResolvedValue(Buffer.from("2026-01-01T00:00:00Z log line 1\n")),
    ...overrides,
  };
}

function mockDocker(containerMock: ReturnType<typeof mockContainer> | null = null) {
  return {
    pull: vi.fn().mockResolvedValue("stream"),
    createContainer: vi.fn().mockResolvedValue(containerMock || mockContainer()),
    listContainers: vi.fn().mockResolvedValue(containerMock ? [{ Id: "container-123" }] : []),
    getContainer: vi.fn().mockReturnValue(containerMock),
    modem: {
      followProgress: vi.fn((_stream: unknown, cb: (err: Error | null) => void) => cb(null)),
    },
  };
}

function mockStore(): ProfileStore {
  const profiles = new Map<string, BotProfile>();
  return {
    init: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockImplementation(async (p: BotProfile) => {
      profiles.set(p.id, p);
    }),
    get: vi.fn().mockImplementation(async (id: string) => profiles.get(id) || null),
    list: vi.fn().mockImplementation(async () => [...profiles.values()]),
    delete: vi.fn().mockImplementation(async (id: string) => profiles.delete(id)),
    dataDir: "/tmp/test-fleet",
  } as unknown as ProfileStore;
}

function mockNetworkPolicy(networkName = "wopr-tenant-user-123") {
  return {
    prepareForContainer: vi.fn().mockResolvedValue(networkName),
    cleanupAfterRemoval: vi.fn().mockResolvedValue(undefined),
    isIsolated: vi.fn().mockResolvedValue(true),
    ensurePlatformNetwork: vi.fn().mockResolvedValue("mgmt-1"),
    networks: {},
  } as unknown as NetworkPolicy;
}

const PROFILE_PARAMS = {
  tenantId: "user-123",
  name: "test-bot",
  description: "A test bot",
  image: "ghcr.io/wopr-network/wopr:stable",
  env: { TOKEN: "abc123" },
  restartPolicy: "unless-stopped" as const,
  releaseChannel: "stable" as const,
  updatePolicy: "manual" as const,
};

describe("FleetManager", () => {
  let docker: ReturnType<typeof mockDocker>;
  let store: ProfileStore;
  let container: ReturnType<typeof mockContainer>;
  let fleet: FleetManager;

  beforeEach(() => {
    container = mockContainer();
    docker = mockDocker(container);
    store = mockStore();
    fleet = new FleetManager(docker as unknown as Docker, store);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("create", () => {
    it("saves profile, pulls image, and creates container", async () => {
      const profile = await fleet.create(PROFILE_PARAMS);

      expect(profile.id).toBeDefined();
      expect(profile.name).toBe("test-bot");
      expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ name: "test-bot" }));
      expect(docker.pull).toHaveBeenCalledWith("ghcr.io/wopr-network/wopr:stable", {});
      expect(docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: "ghcr.io/wopr-network/wopr:stable",
          name: "wopr-test-bot",
        }),
      );
    });

    it("rolls back profile on container creation failure", async () => {
      docker.createContainer.mockRejectedValueOnce(new Error("Docker error"));

      await expect(fleet.create(PROFILE_PARAMS)).rejects.toThrow("Docker error");
      expect(store.delete).toHaveBeenCalled();
    });

    it("rolls back profile on image pull failure", async () => {
      docker.modem.followProgress.mockImplementation((_stream: unknown, cb: (err: Error | null) => void) =>
        cb(new Error("Pull failed")),
      );

      await expect(fleet.create(PROFILE_PARAMS)).rejects.toThrow("Pull failed");
      expect(store.delete).toHaveBeenCalled();
    });
  });

  describe("start", () => {
    it("starts an existing container", async () => {
      // Need the bot in the store first so findContainer returns something
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);

      await fleet.start("bot-id");
      expect(container.start).toHaveBeenCalled();
    });

    it("throws BotNotFoundError when container not found", async () => {
      docker.listContainers.mockResolvedValue([]);
      await expect(fleet.start("missing")).rejects.toThrow(BotNotFoundError);
    });
  });

  describe("stop", () => {
    it("stops a running container", async () => {
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);

      await fleet.stop("bot-id");
      expect(container.stop).toHaveBeenCalled();
    });

    it("throws BotNotFoundError when container not found", async () => {
      docker.listContainers.mockResolvedValue([]);
      await expect(fleet.stop("missing")).rejects.toThrow(BotNotFoundError);
    });
  });

  describe("restart", () => {
    it("pulls image before restarting container", async () => {
      // Store the profile first
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);

      await fleet.restart("bot-id");

      // Pull is called first
      expect(docker.pull).toHaveBeenCalledWith(PROFILE_PARAMS.image, {});
      // Then restart
      expect(container.restart).toHaveBeenCalled();
    });

    it("does not restart if pull fails", async () => {
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.modem.followProgress.mockImplementation((_stream: unknown, cb: (err: Error | null) => void) =>
        cb(new Error("Pull failed")),
      );

      await expect(fleet.restart("bot-id")).rejects.toThrow("Pull failed");
      expect(container.restart).not.toHaveBeenCalled();
    });

    it("throws BotNotFoundError for missing profile", async () => {
      await expect(fleet.restart("missing")).rejects.toThrow(BotNotFoundError);
    });
  });

  describe("remove", () => {
    it("stops running container, removes it, and deletes profile", async () => {
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);

      await fleet.remove("bot-id");

      expect(container.stop).toHaveBeenCalled();
      expect(container.remove).toHaveBeenCalledWith({ v: false });
      expect(store.delete).toHaveBeenCalledWith("bot-id");
    });

    it("removes volumes when requested", async () => {
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);

      await fleet.remove("bot-id", true);

      expect(container.remove).toHaveBeenCalledWith({ v: true });
    });

    it("deletes profile even when no container exists", async () => {
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.listContainers.mockResolvedValue([]);

      await fleet.remove("bot-id");
      expect(store.delete).toHaveBeenCalledWith("bot-id");
    });

    it("throws BotNotFoundError for missing profile", async () => {
      await expect(fleet.remove("missing")).rejects.toThrow(BotNotFoundError);
    });
  });

  describe("status", () => {
    it("returns live status for a running bot", async () => {
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);

      const status = await fleet.status("bot-id");

      expect(status.state).toBe("running");
      expect(status.health).toBe("healthy");
      expect(status.containerId).toBe("container-123");
      expect(status.stats).toBeDefined();
      expect(status.stats?.cpuPercent).toBeGreaterThanOrEqual(0);
    });

    it("returns offline status when no container exists", async () => {
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.listContainers.mockResolvedValue([]);

      const status = await fleet.status("bot-id");

      expect(status.state).toBe("stopped");
      expect(status.containerId).toBeNull();
      expect(status.stats).toBeNull();
    });

    it("throws BotNotFoundError for missing profile", async () => {
      await expect(fleet.status("missing")).rejects.toThrow(BotNotFoundError);
    });
  });

  describe("listAll", () => {
    it("returns status for all bots", async () => {
      await store.save({ id: "bot-1", ...PROFILE_PARAMS, name: "bot-one" });
      await store.save({ id: "bot-2", ...PROFILE_PARAMS, name: "bot-two" });
      docker.listContainers.mockResolvedValue([]);

      const bots = await fleet.listAll();

      expect(bots).toHaveLength(2);
      expect(bots.map((b) => b.name)).toEqual(["bot-one", "bot-two"]);
    });
  });

  describe("logs", () => {
    it("returns container logs", async () => {
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);

      const logs = await fleet.logs("bot-id", 50);

      expect(container.logs).toHaveBeenCalledWith(expect.objectContaining({ tail: 50, stdout: true, stderr: true }));
      expect(logs).toContain("log line 1");
    });

    it("throws BotNotFoundError when container not found", async () => {
      docker.listContainers.mockResolvedValue([]);
      await expect(fleet.logs("missing")).rejects.toThrow(BotNotFoundError);
    });
  });

  describe("update", () => {
    it("updates profile and recreates container if running", async () => {
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);
      // After remove, the new container should be found
      const newContainer = mockContainer();
      docker.createContainer.mockResolvedValue(newContainer);
      // On the second listContainers call (for findContainer after recreate), return the new one
      docker.listContainers
        .mockResolvedValueOnce([{ Id: "container-123" }]) // first find
        .mockResolvedValueOnce([{ Id: "new-container" }]); // second find after recreate
      docker.getContainer
        .mockReturnValueOnce(container) // first find
        .mockReturnValueOnce(newContainer); // second find

      const updated = await fleet.update("bot-id", { image: "ghcr.io/wopr-network/wopr:canary" });

      expect(updated.image).toBe("ghcr.io/wopr-network/wopr:canary");
      expect(docker.pull).toHaveBeenCalledWith("ghcr.io/wopr-network/wopr:canary", {});
      expect(container.stop).toHaveBeenCalled();
      expect(container.remove).toHaveBeenCalled();
    });

    it("throws BotNotFoundError for missing profile", async () => {
      await expect(fleet.update("missing", { name: "new" })).rejects.toThrow(BotNotFoundError);
    });
  });

  describe("proxy integration", () => {
    let proxyManager: {
      addRoute: ReturnType<typeof vi.fn>;
      removeRoute: ReturnType<typeof vi.fn>;
      updateHealth: ReturnType<typeof vi.fn>;
      getRoutes: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      reload: ReturnType<typeof vi.fn>;
    };
    let proxyFleet: FleetManager;

    beforeEach(() => {
      proxyManager = {
        addRoute: vi.fn().mockResolvedValue(undefined),
        removeRoute: vi.fn(),
        updateHealth: vi.fn(),
        getRoutes: vi.fn().mockReturnValue([]),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
      };
      proxyFleet = new FleetManager(
        docker as unknown as Docker,
        store,
        undefined, // platformDiscovery
        undefined, // networkPolicy
        proxyManager as unknown as import("../proxy/types.js").ProxyManagerInterface,
      );
    });

    it("calls addRoute on create with correct subdomain and upstream", async () => {
      const profile = await proxyFleet.create(PROFILE_PARAMS);
      expect(proxyManager.addRoute).toHaveBeenCalledWith({
        instanceId: profile.id,
        subdomain: "test-bot",
        upstreamHost: "wopr-test-bot",
        upstreamPort: 7437,
        healthy: true,
      });
    });

    it("still returns profile when addRoute fails (non-fatal)", async () => {
      proxyManager.addRoute.mockRejectedValueOnce(new Error("DNS fail"));
      const profile = await proxyFleet.create(PROFILE_PARAMS);
      expect(profile.id).toBeDefined();
      expect(profile.name).toBe("test-bot");
    });

    it("calls removeRoute on remove", async () => {
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);
      await proxyFleet.remove("bot-id");
      expect(proxyManager.removeRoute).toHaveBeenCalledWith("bot-id");
    });

    it("calls updateHealth(true) on start", async () => {
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);
      await proxyFleet.start("bot-id");
      expect(proxyManager.updateHealth).toHaveBeenCalledWith("bot-id", true);
    });

    it("calls updateHealth(false) on stop", async () => {
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);
      await proxyFleet.stop("bot-id");
      expect(proxyManager.updateHealth).toHaveBeenCalledWith("bot-id", false);
    });

    it("does not call proxy methods when no proxyManager is provided", async () => {
      // `fleet` from the outer beforeEach has no proxyManager
      const profile = await fleet.create(PROFILE_PARAMS);
      expect(proxyManager.addRoute).not.toHaveBeenCalled();
      expect(profile.id).toBeDefined();
    });

    it("normalizes underscores to hyphens in subdomain", async () => {
      await proxyFleet.create({ ...PROFILE_PARAMS, name: "my_cool_bot" });
      expect(proxyManager.addRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          subdomain: "my-cool-bot",
          upstreamHost: "wopr-my-cool-bot",
        }),
      );
    });
  });

  describe("network isolation", () => {
    let netPolicy: ReturnType<typeof mockNetworkPolicy>;
    let isolatedFleet: FleetManager;

    beforeEach(() => {
      netPolicy = mockNetworkPolicy();
      isolatedFleet = new FleetManager(docker as unknown as Docker, store, undefined, netPolicy);
    });

    it("sets NetworkMode from NetworkPolicy on container creation", async () => {
      await isolatedFleet.create(PROFILE_PARAMS);

      expect(netPolicy.prepareForContainer).toHaveBeenCalledWith("user-123");
      expect(docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            NetworkMode: "wopr-tenant-user-123",
          }),
        }),
      );
    });

    it("does not set NetworkMode when no NetworkPolicy is provided", async () => {
      // fleet (from outer beforeEach) has no networkPolicy
      await fleet.create(PROFILE_PARAMS);

      expect(docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.not.objectContaining({
            NetworkMode: expect.anything(),
          }),
        }),
      );
    });

    it("calls cleanupAfterRemoval on bot removal", async () => {
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);

      await isolatedFleet.remove("bot-id");

      expect(netPolicy.cleanupAfterRemoval).toHaveBeenCalledWith("user-123");
    });

    it("calls cleanupAfterRemoval even when no container exists", async () => {
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.listContainers.mockResolvedValue([]);

      await isolatedFleet.remove("bot-id");

      expect(netPolicy.cleanupAfterRemoval).toHaveBeenCalledWith("user-123");
    });

    it("does not call cleanupAfterRemoval when no NetworkPolicy is provided", async () => {
      await store.save({ id: "bot-id", ...PROFILE_PARAMS });
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);

      await fleet.remove("bot-id");

      // netPolicy is not wired into the default fleet instance
      expect(netPolicy.cleanupAfterRemoval).not.toHaveBeenCalled();
    });
  });

  describe("per-bot mutex", () => {
    it("serializes 5 concurrent startBot calls into exactly 1 start per call", async () => {
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);

      let startCount = 0;
      container.start.mockImplementation(async () => {
        startCount++;
        const current = startCount;
        await new Promise((r) => setTimeout(r, 10));
        expect(startCount).toBe(current);
      });

      const promises = Array.from({ length: 5 }, () => fleet.start("bot-id"));
      await Promise.all(promises);

      expect(container.start).toHaveBeenCalledTimes(5);
    });

    it("does not block operations on different bots (proves concurrency)", async () => {
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);

      let releaseStart!: () => void;
      container.start.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseStart = resolve;
          }),
      );
      const stopSpy = vi.fn();
      container.stop.mockImplementation(async () => {
        stopSpy();
      });

      const startPromise = fleet.start("bot-a");
      await Promise.resolve(); // allow start lock acquisition
      await expect(fleet.stop("bot-b")).resolves.toBeUndefined();
      expect(stopSpy).toHaveBeenCalledTimes(1);
      releaseStart();
      await startPromise;
    });

    it("releases lock even when operation throws", async () => {
      docker.listContainers.mockResolvedValue([]);

      await expect(fleet.start("bot-id")).rejects.toThrow(BotNotFoundError);
      await expect(fleet.start("bot-id")).rejects.toThrow(BotNotFoundError);
    });

    it("serializes concurrent create calls with the same explicit ID (mutual exclusion)", async () => {
      // Add a delay to store.save so the race is observable: the mutex must ensure
      // the first save completes before the second call checks for the existing profile.
      // Without the mutex, both calls could pass the existence check simultaneously,
      // causing a double-save or non-deterministic behaviour.
      const saveOrder: string[] = [];
      (store.save as ReturnType<typeof vi.fn>).mockImplementation(async (p: BotProfile) => {
        saveOrder.push("start");
        await new Promise((r) => setTimeout(r, 10));
        // Simulate what a real store does: persist so subsequent get() can see it
        (store.get as ReturnType<typeof vi.fn>).mockResolvedValue(p);
        saveOrder.push("end");
      });

      const results = await Promise.allSettled([
        fleet.create({ ...PROFILE_PARAMS, id: "explicit-id" }),
        fleet.create({ ...PROFILE_PARAMS, id: "explicit-id" }),
      ]);

      // Exactly one succeeded and one rejected with "already exists"
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already exists/);

      // Exactly one save reached store.save (the second was blocked by the existence check)
      expect(saveOrder).toEqual(["start", "end"]);
    });
  });

  describe("getVolumeUsage", () => {
    it("returns disk usage from running container", async () => {
      const dfOutput =
        "Filesystem     1B-blocks      Used Available Use% Mounted on\n" +
        "/dev/sda1    5368709120 1073741824 4294967296  20% /data\n";

      const execMock = {
        start: vi.fn((_opts: unknown, cb: (err: Error | null, stream: NodeJS.ReadableStream) => void) => {
          const { Readable } = require("node:stream");
          const stream = Readable.from([dfOutput]);
          cb(null, stream);
        }),
      };
      const containerWithExec = mockContainer({
        exec: vi.fn().mockResolvedValue(execMock),
      });
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValue(containerWithExec);

      const result = await fleet.getVolumeUsage("bot-id");

      expect(result).toEqual({
        totalBytes: 5368709120,
        usedBytes: 1073741824,
        availableBytes: 4294967296,
      });
    });

    it("returns null when container is not found", async () => {
      docker.listContainers.mockResolvedValue([]);
      const result = await fleet.getVolumeUsage("bot-id");
      expect(result).toBeNull();
    });

    it("returns null when container is stopped", async () => {
      const stoppedContainer = mockContainer({
        inspect: vi.fn().mockResolvedValue({
          Id: "container-123",
          State: { Running: false },
        }),
      });
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValue(stoppedContainer);

      const result = await fleet.getVolumeUsage("bot-id");
      expect(result).toBeNull();
    });

    it("returns null when exec fails", async () => {
      const containerWithFailingExec = mockContainer({
        exec: vi.fn().mockRejectedValue(new Error("exec failed")),
      });
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValue(containerWithFailingExec);

      const result = await fleet.getVolumeUsage("bot-id");
      expect(result).toBeNull();
    });
  });
});
