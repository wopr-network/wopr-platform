import { NodeAgent } from "@wopr-network/platform-core/node-agent";
import { DockerManager } from "@wopr-network/platform-core/node-agent/docker";
import { nodeAgentConfigSchema } from "@wopr-network/platform-core/node-agent/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted — runs before any import; creates the shared WS instance store
// and a FakeWebSocket class that does NOT extend any imported class.
// ---------------------------------------------------------------------------

const { FakeWebSocket, getWsInstances, resetWsInstances } = vi.hoisted(() => {
  // Minimal event-emitter so the class can live without imports
  class SimpleEmitter {
    private _listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

    on(event: string, fn: (...args: unknown[]) => void) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const fns = this._listeners[event] ?? [];
      for (const fn of fns) fn(...args);
      return fns.length > 0;
    }
  }

  const instances: Array<{
    readyState: number;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => boolean;
    on: (event: string, fn: (...args: unknown[]) => void) => unknown;
  }> = [];

  class FakeWS extends SimpleEmitter {
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static CONNECTING = 0;

    readyState = 1; // WebSocket.OPEN
    send = vi.fn();
    close = vi.fn();

    constructor(_url: string, _opts?: unknown) {
      super();
      instances.push(this);
    }
  }

  return {
    FakeWebSocket: FakeWS,
    getWsInstances: () => instances,
    resetWsInstances: () => {
      instances.length = 0;
    },
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("ws", () => ({
  WebSocket: FakeWebSocket,
}));

vi.mock("node:os", () => ({
  freemem: vi.fn(() => 2 * 1024 * 1024 * 1024),
  totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024),
  uptime: vi.fn(() => 3600),
  hostname: vi.fn(() => "test-host"),
  networkInterfaces: vi.fn(() => ({
    eth0: [{ family: "IPv4", address: "10.0.0.1", internal: false }],
  })),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  createWriteStream: vi.fn().mockReturnValue({ on: vi.fn(), write: vi.fn(), end: vi.fn() }),
  createReadStream: vi.fn().mockReturnValue({ pipe: vi.fn().mockReturnValue("gunzipped-stream"), on: vi.fn() }),
  statfsSync: vi.fn().mockReturnValue({ blocks: 0, bsize: 4096, bavail: 0 }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDockerode() {
  const container = {
    id: "abc123",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      Id: "abc123",
      State: { Status: "running", Running: true, StartedAt: "2026-01-01T00:00:00Z" },
    }),
    stats: vi.fn().mockResolvedValue({
      memory_stats: { usage: 100 * 1024 * 1024 },
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    }),
    logs: vi.fn().mockResolvedValue(Buffer.from("log\n")),
  };
  return {
    docker: {
      pull: vi.fn().mockResolvedValue("stream"),
      createContainer: vi.fn().mockResolvedValue(container),
      listContainers: vi.fn().mockResolvedValue([{ Id: "abc123", Names: ["/tenant_bot1"], State: "running" }]),
      getContainer: vi.fn().mockReturnValue(container),
      getEvents: vi.fn().mockResolvedValue({ on: vi.fn(), destroy: vi.fn() }),
      modem: { followProgress: vi.fn((_s: unknown, cb: (e: Error | null) => void) => cb(null)) },
    },
    container,
  };
}

function validConfig(overrides: Record<string, unknown> = {}) {
  return nodeAgentConfigSchema.parse({
    platformUrl: "https://api.wopr.bot",
    nodeId: "node-test",
    nodeSecret: "test-secret-123",
    heartbeatIntervalMs: 5000,
    backupDir: "/backups",
    s3Bucket: "wopr-backups",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Heartbeat loop tests
// ---------------------------------------------------------------------------

describe("NodeAgent heartbeat loop", () => {
  let baseNow: number;

  beforeEach(() => {
    baseNow = Date.now();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(baseNow);
    resetWsInstances();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue("ok") }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends first heartbeat immediately on WebSocket open, then at configured interval", async () => {
    const config = validConfig({ heartbeatIntervalMs: 5000 });
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    try {
      await agent.start();

      const instances = getWsInstances();
      expect(instances).toHaveLength(1);
      const ws = instances[0];

      // Simulate open — triggers startHeartbeat()
      ws.emit("open");
      await vi.advanceTimersByTimeAsync(0);

      // First heartbeat sent immediately
      expect(ws.send).toHaveBeenCalledTimes(1);
      const firstMsg = JSON.parse(ws.send.mock.calls[0][0] as string) as Record<string, unknown>;
      expect(firstMsg.type).toBe("heartbeat");
      expect(firstMsg.node_id).toBe("node-test");

      // Just before interval — still one heartbeat
      await vi.advanceTimersByTimeAsync(4999);
      expect(ws.send).toHaveBeenCalledTimes(1);

      // At interval boundary — second heartbeat fires
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.send).toHaveBeenCalledTimes(2);

      // Another full interval — third heartbeat
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.send).toHaveBeenCalledTimes(3);
    } finally {
      agent.stop();
    }
  });

  it("does not crash when collectHeartbeat throws — loop continues", async () => {
    const config = validConfig({ heartbeatIntervalMs: 5000 });
    const { docker } = mockDockerode();
    docker.listContainers.mockRejectedValue(new Error("Docker daemon gone"));
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    try {
      await agent.start();
      const ws = getWsInstances()[0];
      ws.emit("open");

      await vi.advanceTimersByTimeAsync(0);
      expect(ws.send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.send).toHaveBeenCalledTimes(2);
    } finally {
      agent.stop();
    }
  });

  it("does not send heartbeat when WebSocket is not open", async () => {
    const config = validConfig({ heartbeatIntervalMs: 5000 });
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    try {
      await agent.start();
      const ws = getWsInstances()[0];

      ws.readyState = 3; // WebSocket.CLOSED
      ws.emit("open");
      await vi.advanceTimersByTimeAsync(0);

      // send() checks readyState === OPEN (1) — nothing sent
      expect(ws.send).not.toHaveBeenCalled();
    } finally {
      agent.stop();
    }
  });

  it("stop() clears heartbeat interval and closes WebSocket", async () => {
    const config = validConfig({ heartbeatIntervalMs: 5000 });
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    await agent.start();
    const ws = getWsInstances()[0];
    ws.emit("open");
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.send).toHaveBeenCalledTimes(1);

    agent.stop();
    expect(ws.close).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15000);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("stop() is safe to call multiple times without throwing", async () => {
    const config = validConfig();
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    await agent.start();
    const ws = getWsInstances()[0];
    ws.emit("open");
    await vi.advanceTimersByTimeAsync(0);

    expect(() => {
      agent.stop();
      agent.stop();
    }).not.toThrow();
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("heartbeat timer is cleared when WebSocket closes before reconnect", async () => {
    const config = validConfig({ heartbeatIntervalMs: 5000 });
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    try {
      await agent.start();
      const ws1 = getWsInstances()[0];
      ws1.emit("open");
      await vi.advanceTimersByTimeAsync(0);

      expect(ws1.send).toHaveBeenCalledTimes(1);

      // Close — stopHeartbeat() fires, then scheduleReconnect with 1s delay
      ws1.emit("close");

      // Advance past heartbeat interval — old timer cleared, no sends on ws1
      await vi.advanceTimersByTimeAsync(5000);
      expect(ws1.send).toHaveBeenCalledTimes(1);

      // Reconnect fires 1s after close (total 6s from close)
      await vi.advanceTimersByTimeAsync(1000);
      expect(getWsInstances()).toHaveLength(2);
      const ws2 = getWsInstances()[1];

      ws2.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      expect(ws2.send).toHaveBeenCalledTimes(1);
    } finally {
      agent.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// WebSocket reconnect backoff tests
// ---------------------------------------------------------------------------

describe("NodeAgent WebSocket reconnect backoff", () => {
  let baseNow: number;

  beforeEach(() => {
    baseNow = Date.now();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(baseNow);
    resetWsInstances();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue("ok") }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reconnects with exponential backoff when WebSocket closes", async () => {
    const config = validConfig({ heartbeatIntervalMs: 5000 });
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    try {
      await agent.start();
      expect(getWsInstances()).toHaveLength(1);

      // First close — reconnect delay is 1000ms
      getWsInstances()[0].emit("close");
      await vi.advanceTimersByTimeAsync(999);
      expect(getWsInstances()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(getWsInstances()).toHaveLength(2);

      // Second close — delay was doubled to 2000ms
      getWsInstances()[1].emit("close");
      await vi.advanceTimersByTimeAsync(1999);
      expect(getWsInstances()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(getWsInstances()).toHaveLength(3);

      // Third close — delay doubled to 4000ms
      getWsInstances()[2].emit("close");
      await vi.advanceTimersByTimeAsync(3999);
      expect(getWsInstances()).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(getWsInstances()).toHaveLength(4);
    } finally {
      agent.stop();
    }
  });

  it("caps reconnect delay at 30 seconds", async () => {
    const config = validConfig({ heartbeatIntervalMs: 5000 });
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    try {
      await agent.start();

      // 5 cycles: delays 1s, 2s, 4s, 8s, 16s — next would be 32s → capped at 30s
      for (let i = 0; i < 5; i++) {
        const instances = getWsInstances();
        instances[instances.length - 1].emit("close");
        const delay = Math.min(1000 * 2 ** i, 30_000);
        await vi.advanceTimersByTimeAsync(delay);
      }

      const countBefore = getWsInstances().length;
      const instances = getWsInstances();
      instances[instances.length - 1].emit("close");

      await vi.advanceTimersByTimeAsync(29_999);
      expect(getWsInstances()).toHaveLength(countBefore);
      await vi.advanceTimersByTimeAsync(1);
      expect(getWsInstances()).toHaveLength(countBefore + 1);
    } finally {
      agent.stop();
    }
  });

  it("resets reconnect delay to 1s after successful connection", async () => {
    const config = validConfig({ heartbeatIntervalMs: 5000 });
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    try {
      await agent.start();

      // First close — 1s delay
      getWsInstances()[0].emit("close");
      await vi.advanceTimersByTimeAsync(1000);
      expect(getWsInstances()).toHaveLength(2);

      // Second close — 2s delay
      getWsInstances()[1].emit("close");
      await vi.advanceTimersByTimeAsync(2000);
      expect(getWsInstances()).toHaveLength(3);

      // Successful open resets delay back to 1s
      getWsInstances()[2].emit("open");
      await vi.advanceTimersByTimeAsync(0);

      // Next close — should reconnect after 1s, not 4s
      getWsInstances()[2].emit("close");
      await vi.advanceTimersByTimeAsync(999);
      expect(getWsInstances()).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(getWsInstances()).toHaveLength(4);
    } finally {
      agent.stop();
    }
  });

  it("does not reconnect after stop()", async () => {
    const config = validConfig({ heartbeatIntervalMs: 5000 });
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    await agent.start();
    expect(getWsInstances()).toHaveLength(1);

    agent.stop();
    getWsInstances()[0].emit("close");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getWsInstances()).toHaveLength(1);
  });

  it("WebSocket error event is handled gracefully without crashing", async () => {
    const config = validConfig({ heartbeatIntervalMs: 5000 });
    const { docker } = mockDockerode();
    const dockerManager = new DockerManager(docker as never);
    const agent = new NodeAgent(config, dockerManager);

    try {
      await agent.start();
      const ws = getWsInstances()[0];
      expect(() => ws.emit("error", new Error("ECONNRESET"))).not.toThrow();
    } finally {
      agent.stop();
    }
  });
});
