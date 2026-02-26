import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatWatchdog, type WatchdogConfig } from "./heartbeat-watchdog.js";
import type { INodeRepository } from "./node-repository.js";

// Minimal INodeRepository shape needed by HeartbeatWatchdog
interface MockNodeRepo {
  list: ReturnType<typeof vi.fn>;
  transition: ReturnType<typeof vi.fn>;
}

function createMockNodeRepo(
  nodes: Array<{ id: string; status: string; lastHeartbeatAt: number | null }> = [],
): MockNodeRepo {
  return {
    list: vi.fn().mockResolvedValue(nodes),
    transition: vi.fn().mockResolvedValue(undefined),
  };
}

describe("HeartbeatWatchdog", () => {
  let nodeRepo: MockNodeRepo;
  let onRecovery: ReturnType<typeof vi.fn>;
  let onStatusChange: (nodeId: string, newStatus: string) => void;
  let watchdog: HeartbeatWatchdog;

  // Use short intervals for testing
  const config: WatchdogConfig = {
    unhealthyThresholdS: 90,
    offlineThresholdS: 300,
    checkIntervalMs: 1000, // 1s for fast tests
  };

  beforeEach(() => {
    vi.useFakeTimers();
    nodeRepo = createMockNodeRepo();
    onRecovery = vi.fn();
    onStatusChange = vi.fn() as unknown as (nodeId: string, newStatus: string) => void;
    watchdog = new HeartbeatWatchdog(
      nodeRepo as unknown as INodeRepository,
      onRecovery as unknown as (nodeId: string) => void,
      onStatusChange,
      config,
    );
  });

  afterEach(() => {
    watchdog.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("transitions active node to unhealthy after 90s no heartbeat", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Node last heartbeat was 100 seconds ago (> 90s threshold)
    nodeRepo.list.mockResolvedValue([{ id: "node-1", status: "active", lastHeartbeatAt: now - 100 }]);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);

    // Should have called transition to "unhealthy"
    expect(nodeRepo.transition).toHaveBeenCalledWith("node-1", "unhealthy", "heartbeat_timeout", "heartbeat_watchdog");

    // Should have called onNodeStatusChange callback
    expect(onStatusChange).toHaveBeenCalledWith("node-1", "unhealthy");

    // Should NOT have triggered recovery
    expect(onRecovery).not.toHaveBeenCalled();
  });

  it("transitions unhealthy node to offline after 300s no heartbeat", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Node last heartbeat was 350 seconds ago (> 300s threshold)
    nodeRepo.list.mockResolvedValue([{ id: "node-2", status: "unhealthy", lastHeartbeatAt: now - 350 }]);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);

    // Should have called transition to "offline"
    expect(nodeRepo.transition).toHaveBeenCalledWith("node-2", "offline", "heartbeat_timeout", "heartbeat_watchdog");

    // Should have called onNodeStatusChange callback
    expect(onStatusChange).toHaveBeenCalledWith("node-2", "offline");

    // Should have triggered recovery via callback
    expect(onRecovery).toHaveBeenCalledWith("node-2");
  });

  it("skips nodes that have never sent a heartbeat", async () => {
    nodeRepo.list.mockResolvedValue([{ id: "node-new", status: "active", lastHeartbeatAt: null }]);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(nodeRepo.transition).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("does not transition active node within 90s threshold", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Node last heartbeat was 30 seconds ago (< 90s threshold)
    nodeRepo.list.mockResolvedValue([{ id: "node-1", status: "active", lastHeartbeatAt: now - 30 }]);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(nodeRepo.transition).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("does not transition unhealthy node within 300s threshold", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Node last heartbeat was 150 seconds ago (> 90s but < 300s)
    nodeRepo.list.mockResolvedValue([{ id: "node-1", status: "unhealthy", lastHeartbeatAt: now - 150 }]);

    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);

    // Should NOT transition (already unhealthy, not yet at 300s)
    expect(nodeRepo.transition).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("calls nodeRepo.list with ['active', 'unhealthy'] statuses", async () => {
    watchdog.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(nodeRepo.list).toHaveBeenCalledWith(["active", "unhealthy"]);
  });
});
