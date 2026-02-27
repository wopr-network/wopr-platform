import type Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "./fleet-manager.js";
import type { ProfileStore } from "./profile-store.js";

function mockContainer() {
  return {
    id: "container-123",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      Id: "container-123",
      Created: "2026-01-01T00:00:00Z",
      State: { Status: "running", Running: true, StartedAt: "2026-01-01T00:00:00Z" },
    }),
    stats: vi.fn().mockResolvedValue({
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 104857600, limit: 1073741824 },
    }),
    logs: vi.fn().mockResolvedValue(Buffer.from("")),
  };
}

function makeDocker(): Docker {
  return {
    pull: vi.fn().mockResolvedValue("stream"),
    createContainer: vi.fn().mockResolvedValue(mockContainer()),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn().mockReturnValue(mockContainer()),
    modem: {
      followProgress: vi.fn((_stream: unknown, cb: (err: Error | null) => void) => cb(null)),
    },
  } as unknown as Docker;
}

function makeStore(): ProfileStore {
  const profiles = new Map();
  return {
    init: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockImplementation(async (p: { id: string }) => {
      profiles.set(p.id, p);
    }),
    get: vi.fn().mockImplementation(async (id: string) => profiles.get(id) || null),
    list: vi.fn().mockImplementation(async () => [...profiles.values()]),
    delete: vi.fn().mockImplementation(async (id: string) => profiles.delete(id)),
    dataDir: "/tmp/test-fleet",
  } as unknown as ProfileStore;
}

const BASE_PARAMS = {
  tenantId: "tenant-1",
  name: "test-bot",
  description: "test",
  image: "ghcr.io/wopr-network/wopr:latest",
  env: {},
  restartPolicy: "unless-stopped" as const,
  releaseChannel: "stable" as const,
  updatePolicy: "manual" as const,
};

describe("FleetManager shared node_modules volume", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SHARED_NODE_MODULES_ENABLED;
    delete process.env.SHARED_NODE_MODULES_VOLUME;
    delete process.env.SHARED_NODE_MODULES_MOUNT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("mounts shared node_modules volume read-only and injects NODE_PATH", async () => {
    const docker = makeDocker();
    const fm = new FleetManager(docker, makeStore());

    await fm.create({ ...BASE_PARAMS, name: "test-bot-1" });

    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    const createOpts = (docker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0];

    const binds: string[] = createOpts.HostConfig.Binds ?? [];
    expect(binds).toContainEqual("wopr-shared-node-modules:/shared/node_modules:ro");

    const envArr: string[] = createOpts.Env;
    expect(envArr).toContainEqual("NODE_PATH=/shared/node_modules");
  });

  it("does not mount shared volume when SHARED_NODE_MODULES_ENABLED=false", async () => {
    process.env.SHARED_NODE_MODULES_ENABLED = "false";

    const docker = makeDocker();
    const fm = new FleetManager(docker, makeStore());

    await fm.create({ ...BASE_PARAMS, name: "test-bot-2" });

    const createOpts = (docker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const binds: string[] = createOpts.HostConfig.Binds ?? [];
    expect(binds.some((b) => b.includes("shared-node-modules"))).toBe(false);

    const envArr: string[] = createOpts.Env;
    expect(envArr.some((e) => e.startsWith("NODE_PATH="))).toBe(false);
  });

  it("preserves per-bot volume mount alongside shared mount", async () => {
    const docker = makeDocker();
    const fm = new FleetManager(docker, makeStore());

    await fm.create({ ...BASE_PARAMS, name: "test-bot-3", volumeName: "bot-data-vol" });

    const createOpts = (docker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const binds: string[] = createOpts.HostConfig.Binds ?? [];
    expect(binds).toContainEqual("bot-data-vol:/data");
    expect(binds).toContainEqual("wopr-shared-node-modules:/shared/node_modules:ro");
  });

  it("respects custom volume name and mount path from env", async () => {
    process.env.SHARED_NODE_MODULES_VOLUME = "custom-vol";
    process.env.SHARED_NODE_MODULES_MOUNT = "/opt/nm";

    const docker = makeDocker();
    const fm = new FleetManager(docker, makeStore());

    await fm.create({ ...BASE_PARAMS, name: "test-bot-4" });

    const createOpts = (docker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const binds: string[] = createOpts.HostConfig.Binds ?? [];
    expect(binds).toContainEqual("custom-vol:/opt/nm:ro");

    const envArr: string[] = createOpts.Env;
    expect(envArr).toContainEqual("NODE_PATH=/opt/nm");
  });
});
