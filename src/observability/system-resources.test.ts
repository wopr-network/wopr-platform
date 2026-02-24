import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemResourceMonitor } from "./system-resources.js";

vi.mock("./sentry.js", () => ({
  captureMessage: vi.fn(),
}));

vi.mock("../config/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Mock node:os to control CPU and memory values
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    loadavg: vi.fn(() => [0.5, 0.5, 0.5]),
    freemem: vi.fn(() => 512 * 1024 * 1024), // 512 MB free
    totalmem: vi.fn(() => 1024 * 1024 * 1024), // 1 GB total
    cpus: vi.fn(() => [{}]), // 1 CPU
  };
});

// Mock statfs to control disk values
vi.mock("node:fs/promises", () => ({
  statfs: vi.fn().mockResolvedValue({
    bsize: 4096,
    blocks: 1000000,
    bavail: 200000, // 80% used
  }),
}));

describe("SystemResourceMonitor", () => {
  let monitor: SystemResourceMonitor;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Restore default implementations after clearAllMocks
    const os = await import("node:os");
    vi.mocked(os.loadavg).mockReturnValue([0.5, 0.5, 0.5]);
    vi.mocked(os.freemem).mockReturnValue(512 * 1024 * 1024);
    vi.mocked(os.totalmem).mockReturnValue(1024 * 1024 * 1024);
    vi.mocked(os.cpus).mockReturnValue([{} as ReturnType<typeof os.cpus>[0]]);

    const fs = await import("node:fs/promises");
    vi.mocked(fs.statfs).mockResolvedValue({
      bsize: 4096,
      blocks: 1000000,
      bavail: 200000,
      bfree: 200000,
      ffree: 100,
      files: 1000,
      type: 0,
    } as Awaited<ReturnType<typeof fs.statfs>>);

    monitor = new SystemResourceMonitor({
      thresholds: { cpuLoadRatio: 0.9, memoryUsageRatio: 0.9, diskUsageRatio: 0.85 },
      dataPath: "/tmp",
    });
  });

  afterEach(() => {
    monitor.stop();
  });

  it("collects a snapshot with resource metrics", async () => {
    const snapshot = await monitor.collect();
    expect(snapshot.cpuLoad1m).toBe(0.5);
    expect(snapshot.cpuCount).toBe(1);
    expect(snapshot.memoryTotalBytes).toBe(1024 * 1024 * 1024);
    expect(snapshot.memoryUsedBytes).toBe(512 * 1024 * 1024);
    expect(snapshot.diskTotalBytes).toBeGreaterThan(0);
    expect(snapshot.timestamp).toBeGreaterThan(0);
  });

  it("getSnapshot returns null before first collect", () => {
    expect(monitor.getSnapshot()).toBeNull();
  });

  it("getSnapshot returns last snapshot after collect", async () => {
    await monitor.collect();
    const snap = monitor.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap?.cpuLoad1m).toBe(0.5);
  });

  it("fires cpu alert when load ratio exceeds threshold", async () => {
    const os = await import("node:os");
    const { captureMessage } = await import("./sentry.js");
    // 1 CPU, load = 1.0 => ratio = 1.0 > 0.9
    vi.mocked(os.loadavg).mockReturnValue([1.0, 1.0, 1.0]);

    await monitor.collect();

    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining("cpu"), "warning");
  });

  it("fires memory alert when usage ratio exceeds threshold", async () => {
    const os = await import("node:os");
    const { captureMessage } = await import("./sentry.js");
    // 50 MB free of 1 GB total => ~95% used > 90%
    vi.mocked(os.freemem).mockReturnValue(50 * 1024 * 1024);

    await monitor.collect();

    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining("memory"), "warning");
  });

  it("does not fire alert when metrics are within thresholds", async () => {
    const { captureMessage } = await import("./sentry.js");
    // defaults: 50% CPU, 50% memory, 80% disk — all under thresholds
    await monitor.collect();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("start and stop do not throw", () => {
    expect(() => monitor.start(100_000)).not.toThrow();
    expect(() => monitor.stop()).not.toThrow();
  });
});
