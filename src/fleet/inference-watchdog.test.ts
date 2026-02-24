import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminNotifier } from "./admin-notifier.js";
import type { DOClient } from "./do-client.js";
import type { IGpuNodeRepository } from "./gpu-node-repository.js";
import { InferenceWatchdog } from "./inference-watchdog.js";

function createMockRepo(
  nodes: Array<{ id: string; host: string | null; dropletId: string | null; status: string }> = [],
) {
  return {
    list: vi.fn().mockReturnValue(nodes),
    updateServiceHealth: vi.fn(),
    updateStatus: vi.fn(),
    setError: vi.fn(),
    insert: vi.fn(),
    getById: vi.fn(),
    updateStage: vi.fn(),
    updateHost: vi.fn(),
    delete: vi.fn(),
  };
}

function createMockDoClient() {
  return {
    rebootDroplet: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockNotifier() {
  return {
    gpuNodeDegraded: vi.fn().mockResolvedValue(undefined),
    gpuNodeFailed: vi.fn().mockResolvedValue(undefined),
  };
}

function mockFetchHealthy() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
}

function mockFetchAllDown() {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
}

function mockFetchPartial(downServices: string[]) {
  const downPorts = downServices.map((s) => {
    const map: Record<string, number> = { llama: 8080, chatterbox: 8081, whisper: 8082, qwen: 8083 };
    return map[s];
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      const port = Number(new URL(url).port);
      if (downPorts.includes(port)) return Promise.reject(new Error("connection refused"));
      return Promise.resolve({ ok: true });
    }),
  );
}

describe("InferenceWatchdog", () => {
  let repo: ReturnType<typeof createMockRepo>;
  let doClient: ReturnType<typeof createMockDoClient>;
  let notifier: ReturnType<typeof createMockNotifier>;
  let watchdog: InferenceWatchdog;

  const opts = { intervalMs: 1000, healthTimeoutMs: 100, rebootThreshold: 2, failedTimeoutMs: 5000 };

  beforeEach(() => {
    vi.useFakeTimers();
    repo = createMockRepo();
    doClient = createMockDoClient();
    notifier = createMockNotifier();
  });

  afterEach(() => {
    watchdog?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("polls health endpoints and updates serviceHealth when all healthy", async () => {
    repo.list.mockReturnValue([{ id: "gpu-1", host: "10.0.0.1", dropletId: "12345", status: "active" }]);
    mockFetchHealthy();

    watchdog = new InferenceWatchdog(
      repo as unknown as IGpuNodeRepository,
      doClient as unknown as DOClient,
      notifier as unknown as AdminNotifier,
      opts,
    );
    watchdog.start();
    await vi.advanceTimersByTimeAsync(opts.intervalMs);

    expect(repo.updateServiceHealth).toHaveBeenCalledWith(
      "gpu-1",
      { llama: "ok", chatterbox: "ok", whisper: "ok", qwen: "ok" },
      expect.any(Number),
    );
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it("marks partial failure in serviceHealth without triggering reboot", async () => {
    repo.list.mockReturnValue([{ id: "gpu-1", host: "10.0.0.1", dropletId: "12345", status: "active" }]);
    mockFetchPartial(["whisper"]);

    watchdog = new InferenceWatchdog(
      repo as unknown as IGpuNodeRepository,
      doClient as unknown as DOClient,
      notifier as unknown as AdminNotifier,
      opts,
    );
    watchdog.start();
    await vi.advanceTimersByTimeAsync(opts.intervalMs);

    expect(repo.updateServiceHealth).toHaveBeenCalledWith(
      "gpu-1",
      { llama: "ok", chatterbox: "ok", whisper: "down", qwen: "ok" },
      expect.any(Number),
    );
    expect(doClient.rebootDroplet).not.toHaveBeenCalled();
  });

  it("reboots after 2 consecutive all-down cycles", async () => {
    repo.list.mockReturnValue([{ id: "gpu-1", host: "10.0.0.1", dropletId: "12345", status: "active" }]);
    mockFetchAllDown();

    watchdog = new InferenceWatchdog(
      repo as unknown as IGpuNodeRepository,
      doClient as unknown as DOClient,
      notifier as unknown as AdminNotifier,
      opts,
    );
    watchdog.start();

    // Cycle 1: all down, no reboot yet
    await vi.advanceTimersByTimeAsync(opts.intervalMs);
    expect(doClient.rebootDroplet).not.toHaveBeenCalled();

    // Cycle 2: all down again → reboot
    await vi.advanceTimersByTimeAsync(opts.intervalMs);
    expect(doClient.rebootDroplet).toHaveBeenCalledWith(12345);
    expect(repo.updateStatus).toHaveBeenCalledWith("gpu-1", "degraded");
    expect(notifier.gpuNodeDegraded).toHaveBeenCalledWith("gpu-1", {
      llama: "down",
      chatterbox: "down",
      whisper: "down",
      qwen: "down",
    });
  });

  it("resets failure count when a service recovers", async () => {
    repo.list.mockReturnValue([{ id: "gpu-1", host: "10.0.0.1", dropletId: "12345", status: "active" }]);
    mockFetchAllDown();

    watchdog = new InferenceWatchdog(
      repo as unknown as IGpuNodeRepository,
      doClient as unknown as DOClient,
      notifier as unknown as AdminNotifier,
      opts,
    );
    watchdog.start();

    // Cycle 1: all down
    await vi.advanceTimersByTimeAsync(opts.intervalMs);

    // Cycle 2: one service recovers → counter resets
    mockFetchPartial(["whisper", "qwen", "chatterbox"]); // llama is up
    await vi.advanceTimersByTimeAsync(opts.intervalMs);
    expect(doClient.rebootDroplet).not.toHaveBeenCalled();
  });

  it("marks failed after 10min post-reboot still all-down", async () => {
    repo.list.mockReturnValue([{ id: "gpu-1", host: "10.0.0.1", dropletId: "12345", status: "active" }]);
    mockFetchAllDown();

    watchdog = new InferenceWatchdog(
      repo as unknown as IGpuNodeRepository,
      doClient as unknown as DOClient,
      notifier as unknown as AdminNotifier,
      { ...opts, failedTimeoutMs: 3000 },
    );
    watchdog.start();

    // 2 cycles → reboot
    await vi.advanceTimersByTimeAsync(opts.intervalMs);
    await vi.advanceTimersByTimeAsync(opts.intervalMs);
    expect(doClient.rebootDroplet).toHaveBeenCalledTimes(1);

    // Wait past failedTimeoutMs while still all-down
    await vi.advanceTimersByTimeAsync(3000);
    // The next cycle after timeout should mark failed
    await vi.advanceTimersByTimeAsync(opts.intervalMs);

    expect(repo.updateStatus).toHaveBeenCalledWith("gpu-1", "failed");
    expect(notifier.gpuNodeFailed).toHaveBeenCalledWith("gpu-1");
  });

  it("skips nodes with null host", async () => {
    repo.list.mockReturnValue([{ id: "gpu-1", host: null, dropletId: "12345", status: "active" }]);
    mockFetchHealthy();

    watchdog = new InferenceWatchdog(
      repo as unknown as IGpuNodeRepository,
      doClient as unknown as DOClient,
      notifier as unknown as AdminNotifier,
      opts,
    );
    watchdog.start();
    await vi.advanceTimersByTimeAsync(opts.intervalMs);

    expect(repo.updateServiceHealth).not.toHaveBeenCalled();
  });

  it("skips reboot when dropletId is null", async () => {
    repo.list.mockReturnValue([{ id: "gpu-1", host: "10.0.0.1", dropletId: null, status: "active" }]);
    mockFetchAllDown();

    watchdog = new InferenceWatchdog(
      repo as unknown as IGpuNodeRepository,
      doClient as unknown as DOClient,
      notifier as unknown as AdminNotifier,
      opts,
    );
    watchdog.start();

    await vi.advanceTimersByTimeAsync(opts.intervalMs);
    await vi.advanceTimersByTimeAsync(opts.intervalMs);

    expect(doClient.rebootDroplet).not.toHaveBeenCalled();
    expect(repo.updateStatus).toHaveBeenCalledWith("gpu-1", "degraded");
  });

  it("queries repo.list with active and degraded statuses", async () => {
    mockFetchHealthy();

    watchdog = new InferenceWatchdog(
      repo as unknown as IGpuNodeRepository,
      doClient as unknown as DOClient,
      notifier as unknown as AdminNotifier,
      opts,
    );
    watchdog.start();
    await vi.advanceTimersByTimeAsync(opts.intervalMs);

    expect(repo.list).toHaveBeenCalledWith(["active", "degraded"]);
  });

  it("does not double-start", () => {
    mockFetchHealthy();
    watchdog = new InferenceWatchdog(
      repo as unknown as IGpuNodeRepository,
      doClient as unknown as DOClient,
      notifier as unknown as AdminNotifier,
      opts,
    );
    watchdog.start();
    watchdog.start(); // second call is no-op
    watchdog.stop();
  });

  it("clears reboot state when node recovers after reboot", async () => {
    repo.list.mockReturnValue([{ id: "gpu-1", host: "10.0.0.1", dropletId: "12345", status: "degraded" }]);
    mockFetchAllDown();

    watchdog = new InferenceWatchdog(
      repo as unknown as IGpuNodeRepository,
      doClient as unknown as DOClient,
      notifier as unknown as AdminNotifier,
      opts,
    );
    watchdog.start();

    // 2 cycles → reboot
    await vi.advanceTimersByTimeAsync(opts.intervalMs);
    await vi.advanceTimersByTimeAsync(opts.intervalMs);
    expect(doClient.rebootDroplet).toHaveBeenCalledTimes(1);

    // Node recovers
    mockFetchHealthy();
    await vi.advanceTimersByTimeAsync(opts.intervalMs);

    expect(repo.updateStatus).toHaveBeenCalledWith("gpu-1", "active");
  });
});
