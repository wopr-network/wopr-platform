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
      expect(docker.pull).toHaveBeenCalledWith("ghcr.io/wopr-network/wopr:stable");
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
      expect(docker.pull).toHaveBeenCalledWith(PROFILE_PARAMS.image);
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
      expect(docker.pull).toHaveBeenCalledWith("ghcr.io/wopr-network/wopr:canary");
      expect(container.stop).toHaveBeenCalled();
      expect(container.remove).toHaveBeenCalled();
    });

    it("throws BotNotFoundError for missing profile", async () => {
      await expect(fleet.update("missing", { name: "new" })).rejects.toThrow(BotNotFoundError);
    });
  });

  describe("network isolation", () => {
    let netPolicy: ReturnType<typeof mockNetworkPolicy>;
    let isolatedFleet: FleetManager;

    beforeEach(() => {
      netPolicy = mockNetworkPolicy();
      isolatedFleet = new FleetManager(
        docker as unknown as Docker,
        store,
        undefined,
        netPolicy,
      );
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
});
