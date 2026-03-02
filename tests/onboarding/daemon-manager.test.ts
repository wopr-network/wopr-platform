import { type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonManager } from "../../src/onboarding/daemon-manager.js";
import type { OnboardingConfig } from "../../src/onboarding/config.js";
import type { WoprClient } from "../../src/onboarding/wopr-client.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue("mock-token"),
}));

const defaultConfig: OnboardingConfig = {
  woprPort: 3847,
  llmProvider: "anthropic",
  llmModel: "claude-sonnet-4-20250514",
  budgetCapCents: 100,
  woprDataDir: "/tmp/test-onboarding-wopr",
  enabled: true,
};

function makeClient(healthy = true): WoprClient {
  return {
    setAuthToken: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(healthy),
    createSession: vi.fn().mockResolvedValue(undefined),
    getSessionHistory: vi.fn().mockResolvedValue([]),
    inject: vi.fn().mockResolvedValue(""),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as WoprClient;
}

function makeFakeProcess(exitOnKill = true): ChildProcess {
  const exitListeners: Array<(code: number | null) => void> = [];
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (code: number | null) => void) => {
      if (event === "exit") exitListeners.push(cb);
    }),
    kill: vi.fn((_sig: string) => {
      if (exitOnKill) {
        setTimeout(() => exitListeners.forEach((l) => l(0)), 0);
      }
    }),
  } as unknown as ChildProcess;
}

describe("DaemonManager", () => {
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import("node:child_process");
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("isReady returns false before start", () => {
    const client = makeClient();
    const manager = new DaemonManager(defaultConfig, client);
    expect(manager.isReady()).toBe(false);
  });

  it("start calls spawn and waits for healthCheck", async () => {
    const fakeProcess = makeFakeProcess();
    spawnMock.mockReturnValue(fakeProcess);

    const client = makeClient(true);
    const manager = new DaemonManager(defaultConfig, client);
    await manager.start();

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(manager.isReady()).toBe(true);
    expect(client.setAuthToken).toHaveBeenCalledWith("mock-token");
  });

  it("start is idempotent — second call is no-op", async () => {
    const fakeProcess = makeFakeProcess();
    spawnMock.mockReturnValue(fakeProcess);

    const client = makeClient(true);
    const manager = new DaemonManager(defaultConfig, client);
    await manager.start();
    const callCount = spawnMock.mock.calls.length;
    await manager.start(); // second call
    expect(spawnMock.mock.calls.length).toBe(callCount);
  });

  it("stop kills the process", async () => {
    const fakeProcess = makeFakeProcess(true);
    spawnMock.mockReturnValue(fakeProcess);

    const client = makeClient(true);
    const manager = new DaemonManager(defaultConfig, client);
    await manager.start();
    await manager.stop();

    expect(fakeProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.isReady()).toBe(false);
  });

  it("stop is no-op when not started", async () => {
    const client = makeClient();
    const manager = new DaemonManager(defaultConfig, client);
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it("start throws when health check never passes", async () => {
    vi.useFakeTimers();
    const fakeProcess = makeFakeProcess();
    spawnMock.mockReturnValue(fakeProcess);

    const client = makeClient(false); // healthCheck always returns false

    const manager = new DaemonManager(defaultConfig, client);
    // Attach rejection handler immediately before advancing timers
    const startPromise = manager.start().catch((e: unknown) => e);

    // Advance past all 30 health check intervals (30 * 1000ms)
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    const result = await startPromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("did not become healthy");
    expect(manager.isReady()).toBe(false);

    vi.useRealTimers();
  });

  it("process exit event resets ready state", async () => {
    const exitListeners: Array<(code: number | null) => void> = [];
    const fakeProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "exit") exitListeners.push(cb as (code: number | null) => void);
      }),
      kill: vi.fn(),
    } as unknown as ChildProcess;
    spawnMock.mockReturnValue(fakeProcess);

    const client = makeClient(true);
    const manager = new DaemonManager(defaultConfig, client);
    await manager.start();
    expect(manager.isReady()).toBe(true);

    // Simulate unexpected daemon exit
    exitListeners.forEach((l) => l(1));
    expect(manager.isReady()).toBe(false);
  });

  it("process error event resets ready state", async () => {
    const errorListeners: Array<(err: Error) => void> = [];
    const exitListeners: Array<(code: number | null) => void> = [];
    const fakeProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "error") errorListeners.push(cb as (err: Error) => void);
        if (event === "exit") exitListeners.push(cb as (code: number | null) => void);
      }),
      kill: vi.fn((_sig: string) => {
        setTimeout(() => exitListeners.forEach((l) => l(0)), 0);
      }),
    } as unknown as ChildProcess;
    spawnMock.mockReturnValue(fakeProcess);

    const client = makeClient(true);
    const manager = new DaemonManager(defaultConfig, client);
    await manager.start();
    expect(manager.isReady()).toBe(true);

    // Simulate process error
    errorListeners.forEach((l) => l(new Error("spawn ENOENT")));
    expect(manager.isReady()).toBe(false);
  });

  it("start succeeds even when auth token file is missing", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const fakeProcess = makeFakeProcess();
    spawnMock.mockReturnValue(fakeProcess);

    const client = makeClient(true);
    const manager = new DaemonManager(defaultConfig, client);
    await manager.start();

    expect(manager.isReady()).toBe(true);
    expect(client.setAuthToken).not.toHaveBeenCalled();

    // Restore default mock for other tests
    vi.mocked(fs.readFileSync).mockReturnValue("mock-token");
  });

  it("stop sends SIGKILL if process does not exit within 5s", async () => {
    vi.useFakeTimers();

    // Process that does NOT exit on kill
    const fakeProcess = makeFakeProcess(false);
    spawnMock.mockReturnValue(fakeProcess);

    const client = makeClient(true);
    const manager = new DaemonManager(defaultConfig, client);

    // Need real timers for the healthCheck await in start()
    vi.useRealTimers();
    await manager.start();
    vi.useFakeTimers();

    const stopPromise = manager.stop();

    expect(fakeProcess.kill).toHaveBeenCalledWith("SIGTERM");

    // Advance past the 5s SIGKILL timeout
    await vi.advanceTimersByTimeAsync(5000);
    await stopPromise;

    expect(fakeProcess.kill).toHaveBeenCalledWith("SIGKILL");
    expect(manager.isReady()).toBe(false);

    vi.useRealTimers();
  });

  it("uses WOPR_BIN env var when set", async () => {
    const original = process.env.WOPR_BIN;
    process.env.WOPR_BIN = "/custom/wopr";

    const fakeProcess = makeFakeProcess();
    spawnMock.mockReturnValue(fakeProcess);

    const client = makeClient(true);
    const manager = new DaemonManager(defaultConfig, client);
    await manager.start();

    expect(spawnMock).toHaveBeenCalledWith(
      "/custom/wopr",
      ["daemon", "start", "--foreground"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );

    if (original === undefined) {
      delete process.env.WOPR_BIN;
    } else {
      process.env.WOPR_BIN = original;
    }
  });
});
