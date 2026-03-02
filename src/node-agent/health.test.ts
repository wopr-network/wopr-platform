import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock statfsSync before importing health.ts
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    statfsSync: vi.fn().mockReturnValue({
      blocks: 1_000_000,
      bsize: 4096,
      bavail: 500_000, // 50% free → 50% used, below threshold
    }),
  };
});

import { statfsSync } from "node:fs";
import type { DockerManager } from "./docker.js";
import { HealthMonitor } from "./health.js";
import type { HealthEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDockerManager(streamOverride?: EventEmitter): DockerManager {
  const stream = streamOverride ?? new EventEmitter();
  return {
    getEventStream: vi.fn().mockResolvedValue(stream),
    restartBot: vi.fn().mockResolvedValue(undefined),
  } as unknown as DockerManager;
}

function collectEvents(): { events: HealthEvent[]; handler: (e: HealthEvent) => void } {
  const events: HealthEvent[] = [];
  return { events, handler: (e: HealthEvent) => events.push(e) };
}

// ---------------------------------------------------------------------------
// HealthMonitor
// ---------------------------------------------------------------------------

describe("HealthMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and stops cleanly", async () => {
    const dm = mockDockerManager();
    const { handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();
    monitor.stop();
  });

  it("emits 'died' event for non-OOM container death", async () => {
    const stream = new EventEmitter();
    const dm = mockDockerManager(stream);
    const { events, handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Action: "die",
          Actor: { Attributes: { name: "tenant_bot1", exitCode: "1" } },
        }),
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("died");
    expect(events[0].container).toBe("tenant_bot1");
    expect(events[0].node_id).toBe("node-1");
    expect(events[0].message).toContain("exit 1");

    // Should attempt restart
    expect(dm.restartBot).toHaveBeenCalledWith("tenant_bot1");

    // Wait for restart promise to resolve, then expect restarted event
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(2);
    expect(events[1].event).toBe("restarted");

    monitor.stop();
  });

  it("emits 'oom_killed' event for exit code 137", async () => {
    const stream = new EventEmitter();
    const dm = mockDockerManager(stream);
    const { events, handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Action: "die",
          Actor: { Attributes: { name: "tenant_bot2", exitCode: "137" } },
        }),
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("oom_killed");
    expect(events[0].message).toContain("OOM-killed");

    monitor.stop();
  });

  it("attempts restart after OOM kill", async () => {
    const stream = new EventEmitter();
    const dm = mockDockerManager(stream);
    const { events, handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Action: "die",
          Actor: { Attributes: { name: "tenant_bot1", exitCode: "137" } },
        }),
      ),
    );

    expect(dm.restartBot).toHaveBeenCalledWith("tenant_bot1");

    await vi.advanceTimersByTimeAsync(0);
    const restartedEvents = events.filter((e) => e.event === "restarted");
    expect(restartedEvents).toHaveLength(1);
    expect(restartedEvents[0].message).toContain("after OOM kill");

    monitor.stop();
  });

  it("emits 'unhealthy' event for health_status: unhealthy action", async () => {
    const stream = new EventEmitter();
    const dm = mockDockerManager(stream);
    const { events, handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Action: "health_status: unhealthy",
          Actor: { Attributes: { name: "tenant_bot1" } },
        }),
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("unhealthy");
    expect(events[0].message).toContain("health check failed");

    monitor.stop();
  });

  it("does not attempt restart for unhealthy events", async () => {
    const stream = new EventEmitter();
    const dm = mockDockerManager(stream);
    const { handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Action: "health_status: unhealthy",
          Actor: { Attributes: { name: "tenant_bot1" } },
        }),
      ),
    );

    expect(dm.restartBot).not.toHaveBeenCalled();

    monitor.stop();
  });

  it("ignores events for non-tenant containers", async () => {
    const stream = new EventEmitter();
    const dm = mockDockerManager(stream);
    const { events, handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Action: "die",
          Actor: { Attributes: { name: "wopr-platform", exitCode: "1" } },
        }),
      ),
    );

    expect(events).toHaveLength(0);

    monitor.stop();
  });

  it("ignores malformed event data", async () => {
    const stream = new EventEmitter();
    const dm = mockDockerManager(stream);
    const { events, handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    stream.emit("data", Buffer.from("not-json"));

    expect(events).toHaveLength(0);

    monitor.stop();
  });

  it("handles die event with missing exit code (reports 'unknown')", async () => {
    const stream = new EventEmitter();
    const dm = mockDockerManager(stream);
    const { events, handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Action: "die",
          Actor: { Attributes: { name: "tenant_bot1" } }, // no exitCode
        }),
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("died");
    expect(events[0].message).toContain("unknown");

    monitor.stop();
  });

  it("emits disk_low event when disk usage exceeds 85%", async () => {
    const dm = mockDockerManager();
    const { events, handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    // Mock high disk usage: 90% used
    vi.mocked(statfsSync).mockReturnValue({
      blocks: 1_000_000,
      bsize: 4096,
      bavail: 100_000, // 10% free → 90% used
    } as ReturnType<typeof statfsSync>);

    await monitor.start();

    // Advance past disk check interval (60s)
    vi.advanceTimersByTime(60_000);

    expect(events.some((e) => e.event === "disk_low")).toBe(true);
    const diskEvent = events.find((e) => e.event === "disk_low") as (typeof events)[0];
    expect(diskEvent.container).toBe("system");
    expect(diskEvent.message).toContain("90%");

    monitor.stop();
  });

  it("does not emit disk_low when usage is below threshold", async () => {
    const dm = mockDockerManager();
    const { events, handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    // Mock normal disk usage: 50% used
    vi.mocked(statfsSync).mockReturnValue({
      blocks: 1_000_000,
      bsize: 4096,
      bavail: 500_000, // 50% free
    } as ReturnType<typeof statfsSync>);

    await monitor.start();
    vi.advanceTimersByTime(60_000);

    expect(events.filter((e) => e.event === "disk_low")).toHaveLength(0);

    monitor.stop();
  });

  it("handles restart failure gracefully (no throw, no restarted event)", async () => {
    const stream = new EventEmitter();
    const dm = mockDockerManager(stream);
    (dm.restartBot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("restart failed"));

    const { events, handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Action: "die",
          Actor: { Attributes: { name: "tenant_bot1", exitCode: "1" } },
        }),
      ),
    );

    // died event emitted
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("died");

    // Wait for restart to resolve (and fail)
    await vi.advanceTimersByTimeAsync(0);

    // No restarted event because restart failed
    expect(events.filter((e) => e.event === "restarted")).toHaveLength(0);

    monitor.stop();
  });

  it("reconnects on stream error when not stopped", async () => {
    const stream1 = new EventEmitter();
    const stream2 = new EventEmitter();
    const dm = mockDockerManager(stream1);
    (dm.getEventStream as ReturnType<typeof vi.fn>).mockResolvedValueOnce(stream1).mockResolvedValueOnce(stream2);

    const { handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    // Emit error on first stream
    stream1.emit("error", new Error("connection lost"));

    // Advance past the 5s reconnect timeout
    await vi.advanceTimersByTimeAsync(5000);

    // Should have called getEventStream a second time
    expect(dm.getEventStream).toHaveBeenCalledTimes(2);

    monitor.stop();
  });

  it("reconnects on stream end when not stopped", async () => {
    const stream1 = new EventEmitter();
    const stream2 = new EventEmitter();
    const dm = mockDockerManager(stream1);
    (dm.getEventStream as ReturnType<typeof vi.fn>).mockResolvedValueOnce(stream1).mockResolvedValueOnce(stream2);

    const { handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    stream1.emit("end");

    await vi.advanceTimersByTimeAsync(5000);

    expect(dm.getEventStream).toHaveBeenCalledTimes(2);

    monitor.stop();
  });

  it("does not reconnect on stream error when stopped", async () => {
    const stream = new EventEmitter();
    const dm = mockDockerManager(stream);

    const { handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();
    monitor.stop();

    // Emit error after stop
    stream.emit("error", new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(5000);

    // Only initial call, no reconnect
    expect(dm.getEventStream).toHaveBeenCalledTimes(1);
  });

  it("buildEvent includes correct structure with type and timestamp", async () => {
    const stream = new EventEmitter();
    const dm = mockDockerManager(stream);
    const { events, handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-42", handler);

    await monitor.start();

    stream.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          Action: "health_status: unhealthy",
          Actor: { Attributes: { name: "tenant_test" } },
        }),
      ),
    );

    expect(events[0]).toMatchObject({
      type: "health_event",
      node_id: "node-42",
      container: "tenant_test",
      event: "unhealthy",
    });
    expect(events[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    monitor.stop();
  });

  it("passes filters to getEventStream", async () => {
    const dm = mockDockerManager();
    const { handler } = collectEvents();
    const monitor = new HealthMonitor(dm, "node-1", handler);

    await monitor.start();

    expect(dm.getEventStream).toHaveBeenCalledWith({
      filters: { type: ["container"] },
    });

    monitor.stop();
  });
});
