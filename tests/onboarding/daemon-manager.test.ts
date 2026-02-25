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
});
