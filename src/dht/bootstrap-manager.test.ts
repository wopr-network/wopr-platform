import type Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DhtBootstrapManager } from "./bootstrap-manager.js";
import { DHT_CONTAINER_PREFIX, DHT_LABELS, DHT_VOLUME_PREFIX, type DhtConfig } from "./types.js";

function defaultConfig(overrides: Partial<DhtConfig> = {}): DhtConfig {
  return {
    nodeCount: 3,
    basePort: 49737,
    image: "wopr-dht-bootstrap:latest",
    externalAddresses: [],
    ...overrides,
  };
}

function mockDocker() {
  const volume = {
    inspect: vi.fn().mockResolvedValue({}),
  };
  return {
    createContainer: vi.fn(),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn(),
    createVolume: vi.fn().mockResolvedValue({}),
    getVolume: vi.fn().mockReturnValue(volume),
    _volume: volume,
  };
}

function mockContainer(id: string, name: string, running = false) {
  return {
    id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      Id: id,
      Name: name,
      State: { Running: running },
    }),
  };
}

describe("DhtBootstrapManager", () => {
  let docker: ReturnType<typeof mockDocker>;
  let manager: DhtBootstrapManager;

  beforeEach(() => {
    docker = mockDocker();
    manager = new DhtBootstrapManager(docker as unknown as Docker, defaultConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("containerName / volumeName", () => {
    it("generates correct container names", () => {
      expect(DhtBootstrapManager.containerName(0)).toBe(`${DHT_CONTAINER_PREFIX}0`);
      expect(DhtBootstrapManager.containerName(2)).toBe(`${DHT_CONTAINER_PREFIX}2`);
    });

    it("generates correct volume names", () => {
      expect(DhtBootstrapManager.volumeName(0)).toBe(`${DHT_VOLUME_PREFIX}0`);
      expect(DhtBootstrapManager.volumeName(1)).toBe(`${DHT_VOLUME_PREFIX}1`);
    });
  });

  describe("ensureNode", () => {
    it("creates a new container when none exists", async () => {
      const container = mockContainer("c-0", `${DHT_CONTAINER_PREFIX}0`);
      docker.createContainer.mockResolvedValue(container);

      const status = await manager.ensureNode(0);

      expect(status.index).toBe(0);
      expect(status.containerId).toBe("c-0");
      expect(status.state).toBe("running");
      expect(status.address).toEqual({ host: `${DHT_CONTAINER_PREFIX}0`, port: 49737 });
      expect(status.volumeName).toBe(`${DHT_VOLUME_PREFIX}0`);
      expect(docker.createContainer).toHaveBeenCalledOnce();
      expect(container.start).toHaveBeenCalledOnce();
    });

    it("starts a stopped existing container", async () => {
      const container = mockContainer("c-1", `${DHT_CONTAINER_PREFIX}1`, false);
      docker.listContainers.mockResolvedValue([{ Id: "c-1", Names: [`/${DHT_CONTAINER_PREFIX}1`] }]);
      docker.getContainer.mockReturnValue(container);

      const status = await manager.ensureNode(1);

      expect(status.state).toBe("running");
      expect(container.start).toHaveBeenCalledOnce();
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it("skips start for an already-running container", async () => {
      const container = mockContainer("c-0", `${DHT_CONTAINER_PREFIX}0`, true);
      docker.listContainers.mockResolvedValue([{ Id: "c-0", Names: [`/${DHT_CONTAINER_PREFIX}0`] }]);
      docker.getContainer.mockReturnValue(container);

      const status = await manager.ensureNode(0);

      expect(status.state).toBe("running");
      expect(container.start).not.toHaveBeenCalled();
    });

    it("creates volume when it does not exist", async () => {
      docker._volume.inspect.mockRejectedValue(new Error("no such volume"));
      const container = mockContainer("c-0", `${DHT_CONTAINER_PREFIX}0`);
      docker.createContainer.mockResolvedValue(container);

      await manager.ensureNode(0);

      expect(docker.createVolume).toHaveBeenCalledWith({ Name: `${DHT_VOLUME_PREFIX}0` });
    });

    it("passes DHT_PEERS env excluding self", async () => {
      const container = mockContainer("c-1", `${DHT_CONTAINER_PREFIX}1`);
      docker.createContainer.mockResolvedValue(container);

      await manager.ensureNode(1);

      const createCall = docker.createContainer.mock.calls[0][0];
      const peersEnv = createCall.Env.find((e: string) => e.startsWith("DHT_PEERS="));
      // Node 1 should reference nodes 0 and 2
      expect(peersEnv).toBe(`DHT_PEERS=${DHT_CONTAINER_PREFIX}0:49737,${DHT_CONTAINER_PREFIX}2:49739`);
    });

    it("uses correct port for each node index", async () => {
      const container = mockContainer("c-2", `${DHT_CONTAINER_PREFIX}2`);
      docker.createContainer.mockResolvedValue(container);

      const status = await manager.ensureNode(2);

      expect(status.address.port).toBe(49739);
      const createCall = docker.createContainer.mock.calls[0][0];
      expect(createCall.Env).toContain("DHT_PORT=49739");
    });

    it("sets expected labels", async () => {
      const container = mockContainer("c-0", `${DHT_CONTAINER_PREFIX}0`);
      docker.createContainer.mockResolvedValue(container);

      await manager.ensureNode(0);

      const createCall = docker.createContainer.mock.calls[0][0];
      expect(createCall.Labels).toEqual({
        [DHT_LABELS.managed]: "true",
        [DHT_LABELS.nodeIndex]: "0",
      });
    });
  });

  describe("ensureAll", () => {
    it("ensures all configured nodes", async () => {
      const containers = [0, 1, 2].map((i) => mockContainer(`c-${i}`, `${DHT_CONTAINER_PREFIX}${i}`));
      docker.createContainer.mockImplementation(async () => {
        const idx = docker.createContainer.mock.calls.length - 1;
        return containers[idx];
      });

      const statuses = await manager.ensureAll();

      expect(statuses).toHaveLength(3);
      expect(docker.createContainer).toHaveBeenCalledTimes(3);
    });
  });

  describe("removeNode", () => {
    it("stops and removes an existing container", async () => {
      const container = mockContainer("c-0", `${DHT_CONTAINER_PREFIX}0`, true);
      docker.listContainers.mockResolvedValue([{ Id: "c-0", Names: [`/${DHT_CONTAINER_PREFIX}0`] }]);
      docker.getContainer.mockReturnValue(container);

      await manager.removeNode(0);

      expect(container.stop).toHaveBeenCalledOnce();
      expect(container.remove).toHaveBeenCalledOnce();
    });

    it("removes a stopped container without calling stop", async () => {
      const container = mockContainer("c-0", `${DHT_CONTAINER_PREFIX}0`, false);
      docker.listContainers.mockResolvedValue([{ Id: "c-0", Names: [`/${DHT_CONTAINER_PREFIX}0`] }]);
      docker.getContainer.mockReturnValue(container);

      await manager.removeNode(0);

      expect(container.stop).not.toHaveBeenCalled();
      expect(container.remove).toHaveBeenCalledOnce();
    });

    it("does nothing when container does not exist", async () => {
      await manager.removeNode(0);
      // No assertions needed — should not throw
    });
  });

  describe("removeAll", () => {
    it("removes all configured nodes", async () => {
      const containers = [0, 1, 2].map((i) => mockContainer(`c-${i}`, `${DHT_CONTAINER_PREFIX}${i}`, true));
      docker.listContainers.mockImplementation(async (opts: { filters: { name: string[] } }) => {
        const nameFilter = opts.filters?.name?.[0];
        const idx = containers.findIndex((_c, i) => nameFilter === `${DHT_CONTAINER_PREFIX}${i}`);
        if (idx >= 0) {
          return [{ Id: `c-${idx}`, Names: [`/${DHT_CONTAINER_PREFIX}${idx}`] }];
        }
        return [];
      });
      docker.getContainer.mockImplementation((id: string) => {
        const idx = Number.parseInt(id.replace("c-", ""), 10);
        return containers[idx];
      });

      await manager.removeAll();

      for (const c of containers) {
        expect(c.stop).toHaveBeenCalledOnce();
        expect(c.remove).toHaveBeenCalledOnce();
      }
    });
  });

  describe("statusNode", () => {
    it("returns not_found when container does not exist", async () => {
      const status = await manager.statusNode(0);

      expect(status.state).toBe("not_found");
      expect(status.containerId).toBeNull();
    });

    it("returns running for a running container", async () => {
      const container = mockContainer("c-0", `${DHT_CONTAINER_PREFIX}0`, true);
      docker.listContainers.mockResolvedValue([{ Id: "c-0", Names: [`/${DHT_CONTAINER_PREFIX}0`] }]);
      docker.getContainer.mockReturnValue(container);

      const status = await manager.statusNode(0);

      expect(status.state).toBe("running");
      expect(status.containerId).toBe("c-0");
    });

    it("returns stopped for a stopped container", async () => {
      const container = mockContainer("c-0", `${DHT_CONTAINER_PREFIX}0`, false);
      docker.listContainers.mockResolvedValue([{ Id: "c-0", Names: [`/${DHT_CONTAINER_PREFIX}0`] }]);
      docker.getContainer.mockReturnValue(container);

      const status = await manager.statusNode(0);

      expect(status.state).toBe("stopped");
    });
  });

  describe("getBootstrapAddresses", () => {
    it("returns derived addresses when no external addresses configured", () => {
      const addresses = manager.getBootstrapAddresses();

      expect(addresses).toEqual([
        { host: `${DHT_CONTAINER_PREFIX}0`, port: 49737 },
        { host: `${DHT_CONTAINER_PREFIX}1`, port: 49738 },
        { host: `${DHT_CONTAINER_PREFIX}2`, port: 49739 },
      ]);
    });

    it("returns external addresses when configured", () => {
      const config = defaultConfig({
        externalAddresses: [
          { host: "dht1.wopr.io", port: 49737 },
          { host: "dht2.wopr.io", port: 49737 },
        ],
      });
      const mgr = new DhtBootstrapManager(docker as unknown as Docker, config);

      const addresses = mgr.getBootstrapAddresses();

      expect(addresses).toEqual([
        { host: "dht1.wopr.io", port: 49737 },
        { host: "dht2.wopr.io", port: 49737 },
      ]);
    });

    it("respects custom nodeCount", () => {
      const config = defaultConfig({ nodeCount: 2 });
      const mgr = new DhtBootstrapManager(docker as unknown as Docker, config);

      const addresses = mgr.getBootstrapAddresses();

      expect(addresses).toHaveLength(2);
    });
  });
});
