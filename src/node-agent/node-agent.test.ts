import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupManager } from "./backup.js";
import { DockerManager } from "./docker.js";
import { HealthMonitor } from "./health.js";
import { collectHeartbeat } from "./heartbeat.js";
import { NodeAgent } from "./index.js";
import { ALLOWED_COMMANDS, commandSchema, nodeAgentConfigSchema } from "./types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function mockDockerode() {
  const container = {
    id: "abc123",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    export: vi.fn().mockReturnValue(
      Object.assign(Buffer.from(""), {
        on: vi.fn(),
        pipe: vi.fn().mockReturnThis(),
        [Symbol.asyncIterator]: vi.fn(),
      }),
    ),
    inspect: vi.fn().mockResolvedValue({
      Id: "abc123",
      State: { Status: "running", Running: true, StartedAt: "2026-01-01T00:00:00Z" },
    }),
    stats: vi.fn().mockResolvedValue({
      memory_stats: { usage: 100 * 1024 * 1024 },
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    }),
    logs: vi.fn().mockResolvedValue(Buffer.from("log line 1\nlog line 2\n")),
  };

  return {
    docker: {
      pull: vi.fn().mockResolvedValue("stream"),
      createContainer: vi.fn().mockResolvedValue(container),
      listContainers: vi.fn().mockResolvedValue([
        { Id: "abc123", Names: ["/tenant_bot1"], State: "running" },
        { Id: "def456", Names: ["/tenant_bot2"], State: "running" },
      ]),
      getContainer: vi.fn().mockReturnValue(container),
      getEvents: vi.fn().mockResolvedValue({
        on: vi.fn(),
        destroy: vi.fn(),
      }),
      importImage: vi.fn().mockResolvedValue("stream"),
      modem: {
        followProgress: vi.fn((_stream: unknown, cb: (err: Error | null) => void) => cb(null)),
      },
    },
    container,
  };
}

function validConfig() {
  return nodeAgentConfigSchema.parse({
    platformUrl: "https://api.wopr.bot",
    nodeId: "node-test",
    nodeSecret: "test-secret-123",
    heartbeatIntervalMs: 30000,
    backupDir: "/backups",
    s3Bucket: "wopr-backups",
  });
}

// ---------------------------------------------------------------------------
// types.ts tests
// ---------------------------------------------------------------------------

describe("nodeAgentConfigSchema", () => {
  it("parses valid config", () => {
    const config = nodeAgentConfigSchema.parse({
      platformUrl: "https://api.wopr.bot",
      nodeId: "node-2",
      nodeSecret: "secret123",
    });
    expect(config.platformUrl).toBe("https://api.wopr.bot");
    expect(config.nodeId).toBe("node-2");
    expect(config.heartbeatIntervalMs).toBe(30_000);
    expect(config.backupDir).toBe("/backups");
    expect(config.s3Bucket).toBe("wopr-backups");
  });

  it("rejects missing required fields", () => {
    expect(() => nodeAgentConfigSchema.parse({})).toThrow();
    expect(() => nodeAgentConfigSchema.parse({ platformUrl: "https://x.com" })).toThrow();
  });

  it("rejects invalid platformUrl", () => {
    expect(() =>
      nodeAgentConfigSchema.parse({
        platformUrl: "not-a-url",
        nodeId: "node-1",
        nodeSecret: "secret",
      }),
    ).toThrow();
  });
});

describe("commandSchema", () => {
  it("parses valid command", () => {
    const cmd = commandSchema.parse({
      id: "cmd-1",
      type: "bot.start",
      payload: { name: "tenant_abc", image: "ghcr.io/wopr-network/bot:latest" },
    });
    expect(cmd.type).toBe("bot.start");
    expect(cmd.id).toBe("cmd-1");
  });

  it("defaults payload to empty object", () => {
    const cmd = commandSchema.parse({ id: "cmd-2", type: "bot.stop" });
    expect(cmd.payload).toEqual({});
  });

  it("rejects unknown command types", () => {
    const result = commandSchema.safeParse({ id: "cmd-3", type: "bot.destroy" });
    expect(result.success).toBe(false);
  });

  it("validates all allowed commands", () => {
    for (const type of ALLOWED_COMMANDS) {
      const result = commandSchema.safeParse({ id: `cmd-${type}`, type });
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// DockerManager tests
// ---------------------------------------------------------------------------

describe("DockerManager", () => {
  it("lists only tenant containers", async () => {
    const { docker } = mockDockerode();
    docker.listContainers.mockResolvedValue([
      { Id: "1", Names: ["/tenant_abc"], State: "running" },
      { Id: "2", Names: ["/wopr-platform"], State: "running" },
      { Id: "3", Names: ["/tenant_def"], State: "stopped" },
    ]);

    const manager = new DockerManager(docker as never);
    const containers = await manager.listTenantContainers();
    expect(containers).toHaveLength(2);
    expect(containers.map((c) => c.Id)).toEqual(["1", "3"]);
  });

  it("stops a bot by name", async () => {
    const { docker, container } = mockDockerode();
    const manager = new DockerManager(docker as never);

    await manager.stopBot("tenant_abc");
    expect(docker.getContainer).toHaveBeenCalledWith("tenant_abc");
    expect(container.stop).toHaveBeenCalled();
  });

  it("restarts a bot by name", async () => {
    const { docker, container } = mockDockerode();
    const manager = new DockerManager(docker as never);

    await manager.restartBot("tenant_abc");
    expect(container.restart).toHaveBeenCalled();
  });

  it("removes a bot (stops first then removes)", async () => {
    const { docker, container } = mockDockerode();
    const manager = new DockerManager(docker as never);

    await manager.removeBot("tenant_abc");
    expect(container.stop).toHaveBeenCalled();
    expect(container.remove).toHaveBeenCalled();
  });

  it("gets container logs", async () => {
    const { docker, container } = mockDockerode();
    const manager = new DockerManager(docker as never);

    const logs = await manager.getLogs("tenant_abc", 50);
    expect(container.logs).toHaveBeenCalledWith(expect.objectContaining({ tail: 50, stdout: true, stderr: true }));
    expect(logs).toContain("log line");
  });

  it("inspects a container", async () => {
    const { docker, container } = mockDockerode();
    const manager = new DockerManager(docker as never);

    const info = await manager.inspectBot("tenant_abc");
    expect(container.inspect).toHaveBeenCalled();
    expect(info.State.Running).toBe(true);
  });

  it("starts a bot with image pull", async () => {
    const { docker, container } = mockDockerode();
    const manager = new DockerManager(docker as never);

    const id = await manager.startBot({
      name: "mybot",
      image: "ghcr.io/wopr-network/bot:latest",
      env: { TOKEN: "abc" },
    });

    expect(docker.pull).toHaveBeenCalledWith("ghcr.io/wopr-network/bot:latest");
    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Image: "ghcr.io/wopr-network/bot:latest",
        name: "tenant_mybot",
        Env: ["TOKEN=abc"],
      }),
    );
    expect(container.start).toHaveBeenCalled();
    expect(id).toBe("abc123");
  });

  it("prefixes tenant_ to container names", async () => {
    const { docker } = mockDockerode();
    const manager = new DockerManager(docker as never);

    await manager.startBot({ name: "bot1", image: "img:latest" });
    expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ name: "tenant_bot1" }));

    // Already prefixed names should not be double-prefixed
    await manager.startBot({ name: "tenant_bot2", image: "img:latest" });
    expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ name: "tenant_bot2" }));
  });
});

// ---------------------------------------------------------------------------
// Heartbeat tests
// ---------------------------------------------------------------------------

describe("collectHeartbeat", () => {
  it("returns heartbeat with correct structure", async () => {
    const { docker } = mockDockerode();
    const manager = new DockerManager(docker as never);

    const heartbeat = await collectHeartbeat("node-test", manager);

    expect(heartbeat.type).toBe("heartbeat");
    expect(heartbeat.node_id).toBe("node-test");
    expect(typeof heartbeat.uptime_s).toBe("number");
    expect(typeof heartbeat.memory_total_mb).toBe("number");
    expect(typeof heartbeat.memory_used_mb).toBe("number");
    expect(heartbeat.memory_total_mb).toBeGreaterThan(0);
    expect(Array.isArray(heartbeat.containers)).toBe(true);
  });

  it("includes tenant container metrics", async () => {
    const { docker } = mockDockerode();
    const manager = new DockerManager(docker as never);

    const heartbeat = await collectHeartbeat("node-test", manager);

    // Should include tenant_bot1 and tenant_bot2 from mock
    expect(heartbeat.containers?.length).toBeGreaterThanOrEqual(2);
    expect(heartbeat.containers?.[0].name).toBe("tenant_bot1");
    expect(heartbeat.containers?.[0].status).toBe("running");
    expect(typeof heartbeat.containers?.[0].memory_mb).toBe("number");
  });

  it("returns empty containers and logs error when listTenantContainers throws", async () => {
    const failingDocker = {
      listContainers: vi.fn().mockRejectedValue(new Error("Docker daemon unavailable")),
      getContainer: vi.fn(),
    };
    const manager = new DockerManager(failingDocker as never);

    const heartbeat = await collectHeartbeat("node-fail", manager);
    expect(heartbeat.node_id).toBe("node-fail");
    expect(heartbeat.containers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HealthMonitor tests
// ---------------------------------------------------------------------------

describe("HealthMonitor", () => {
  let events: Array<{ event: string; container: string }>;

  beforeEach(() => {
    events = [];
  });

  it("starts and stops without error", async () => {
    const { docker } = mockDockerode();
    const manager = new DockerManager(docker as never);

    const monitor = new HealthMonitor(manager, "node-test", (event) => {
      events.push({ event: event.event, container: event.container });
    });

    await monitor.start();
    monitor.stop();
  });
});

// ---------------------------------------------------------------------------
// BackupManager tests
// ---------------------------------------------------------------------------

describe("BackupManager", () => {
  it("constructs without error", () => {
    const { docker } = mockDockerode();
    const manager = new DockerManager(docker as never);
    const backup = new BackupManager(manager, "/backups", "wopr-backups");
    expect(backup).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// NodeAgent tests
// ---------------------------------------------------------------------------

describe("NodeAgent", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue("ok"),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("constructs with valid config", () => {
    const config = validConfig();
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);
    expect(agent).toBeDefined();
  });

  it("stop is idempotent", () => {
    const config = validConfig();
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    agent.stop();
    agent.stop(); // should not throw
  });
});

// ---------------------------------------------------------------------------
// Command allowlist tests
// ---------------------------------------------------------------------------

describe("ALLOWED_COMMANDS", () => {
  it("includes all expected commands", () => {
    const expected = [
      "bot.start",
      "bot.stop",
      "bot.restart",
      "bot.export",
      "bot.import",
      "bot.remove",
      "bot.logs",
      "bot.inspect",
      "backup.upload",
      "backup.download",
      "backup.run-nightly",
    ];
    for (const cmd of expected) {
      expect(ALLOWED_COMMANDS).toContain(cmd);
    }
  });

  it("has exactly 12 commands", () => {
    expect(ALLOWED_COMMANDS).toHaveLength(12);
  });
});
