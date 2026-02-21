import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatWatchdog, type WatchdogConfig } from "./heartbeat-watchdog.js";
import type { RecoveryManager } from "./recovery-manager.js";

// Minimal INodeRepository shape needed by HeartbeatWatchdog
interface MockNodeRepo {
  list: ReturnType<typeof vi.fn>;
  transition: ReturnType<typeof vi.fn>;
}

function createMockNodeRepo(
  nodes: Array<{ id: string; status: string; lastHeartbeatAt: number | null }> = [],
): MockNodeRepo {
  return {
    list: vi.fn().mockReturnValue(nodes),
    transition: vi.fn(),
  };
}

function createMockRecoveryManager(): { triggerRecovery: ReturnType<typeof vi.fn> } {
  return {
    triggerRecovery: vi.fn().mockResolvedValue({
      recovered: [],
      failed: [],
      skipped: [],
      waiting: [],
    }),
  };
}

describe("HeartbeatWatchdog", () => {
  let nodeRepo: MockNodeRepo;
  let recoveryManager: ReturnType<typeof createMockRecoveryManager>;
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
    recoveryManager = createMockRecoveryManager();
    onStatusChange = vi.fn() as unknown as (nodeId: string, newStatus: string) => void;
    watchdog = new HeartbeatWatchdog(
      nodeRepo as any,
      recoveryManager as unknown as RecoveryManager,
      onStatusChange,
      config,
    );
  });

  afterEach(() => {
    watchdog.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("transitions active node to unhealthy after 90s no heartbeat", () => {
    const now = Math.floor(Date.now() / 1000);

    // Node last heartbeat was 100 seconds ago (> 90s threshold)
    nodeRepo.list.mockReturnValue([{ id: "node-1", status: "active", lastHeartbeatAt: now - 100 }]);

    watchdog.start();
    vi.advanceTimersByTime(config.checkIntervalMs!);

    // Should have called transition to "unhealthy"
    expect(nodeRepo.transition).toHaveBeenCalledWith("node-1", "unhealthy", "heartbeat_timeout", "heartbeat_watchdog");

    // Should have called onNodeStatusChange callback
    expect(onStatusChange).toHaveBeenCalledWith("node-1", "unhealthy");

    // Should NOT have triggered recovery
    expect(recoveryManager.triggerRecovery).not.toHaveBeenCalled();
  });

  it("transitions unhealthy node to offline after 300s no heartbeat", () => {
    const now = Math.floor(Date.now() / 1000);

    // Node last heartbeat was 350 seconds ago (> 300s threshold)
    nodeRepo.list.mockReturnValue([{ id: "node-2", status: "unhealthy", lastHeartbeatAt: now - 350 }]);

    watchdog.start();
    vi.advanceTimersByTime(config.checkIntervalMs!);

    // Should have called transition to "offline"
    expect(nodeRepo.transition).toHaveBeenCalledWith("node-2", "offline", "heartbeat_timeout", "heartbeat_watchdog");

    // Should have called onNodeStatusChange callback
    expect(onStatusChange).toHaveBeenCalledWith("node-2", "offline");

    // Should have triggered recovery
    expect(recoveryManager.triggerRecovery).toHaveBeenCalledWith("node-2", "heartbeat_timeout");
  });

  it("skips nodes that have never sent a heartbeat", () => {
    nodeRepo.list.mockReturnValue([{ id: "node-new", status: "active", lastHeartbeatAt: null }]);

    watchdog.start();
    vi.advanceTimersByTime(config.checkIntervalMs!);

    expect(nodeRepo.transition).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("does not transition active node within 90s threshold", () => {
    const now = Math.floor(Date.now() / 1000);

    // Node last heartbeat was 30 seconds ago (< 90s threshold)
    nodeRepo.list.mockReturnValue([{ id: "node-1", status: "active", lastHeartbeatAt: now - 30 }]);

    watchdog.start();
    vi.advanceTimersByTime(config.checkIntervalMs!);

    expect(nodeRepo.transition).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("does not transition unhealthy node within 300s threshold", () => {
    const now = Math.floor(Date.now() / 1000);

    // Node last heartbeat was 150 seconds ago (> 90s but < 300s)
    nodeRepo.list.mockReturnValue([{ id: "node-1", status: "unhealthy", lastHeartbeatAt: now - 150 }]);

    watchdog.start();
    vi.advanceTimersByTime(config.checkIntervalMs!);

    // Should NOT transition (already unhealthy, not yet at 300s)
    expect(nodeRepo.transition).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("calls nodeRepo.list with ['active', 'unhealthy'] statuses", () => {
    watchdog.start();
    vi.advanceTimersByTime(config.checkIntervalMs!);

    expect(nodeRepo.list).toHaveBeenCalledWith(["active", "unhealthy"]);
  });
});
