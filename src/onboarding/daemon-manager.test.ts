import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { OnboardingConfig } from "./config.js";
import { DaemonManager } from "./daemon-manager.js";
import type { WoprClient } from "./wopr-client.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

function mockConfig(): OnboardingConfig {
  return {
    woprPort: 9999,
    llmProvider: "test",
    llmModel: "test",
    woprDataDir: "/tmp/daemon-manager-test",
    enabled: true,
  };
}

function makeFakeProcess(): ChildProcess {
  const fakeProcess = new EventEmitter();
  return Object.assign(fakeProcess, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    pid: 1234,
    stdin: null,
    stdio: [],
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: "",
    connected: false,
    channel: undefined,
    disconnect: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    send: vi.fn(),
  }) as unknown as ChildProcess;
}

describe("DaemonManager", () => {
  describe("start() race condition", () => {
    it("should NOT mark ready when process exits after waitForReady but before ready flag", async () => {
      const config = mockConfig();
      const client = { setAuthToken: vi.fn(), healthCheck: vi.fn() } as unknown as WoprClient;
      client.healthCheck = vi.fn().mockResolvedValue(true);

      const fakeProcess = makeFakeProcess();
      vi.mocked(spawn).mockReturnValue(fakeProcess);

      // readFileSync triggers process exit — simulates race between health check and ready flag
      vi.mocked(readFileSync).mockImplementation(() => {
        fakeProcess.emit("exit", 1);
        return "fake-token";
      });

      const dm = new DaemonManager(config, client);
      await dm.start();

      // Process exited during token read, so ready MUST be false
      expect(dm.isReady()).toBe(false);
    });

    it("should mark ready when process stays alive through start()", async () => {
      const config = mockConfig();
      const client = { setAuthToken: vi.fn(), healthCheck: vi.fn() } as unknown as WoprClient;
      client.healthCheck = vi.fn().mockResolvedValue(true);

      const fakeProcess = makeFakeProcess();
      vi.mocked(spawn).mockReturnValue(fakeProcess);
      vi.mocked(readFileSync).mockReturnValue("fake-token");

      const dm = new DaemonManager(config, client);
      await dm.start();

      expect(dm.isReady()).toBe(true);
      expect(client.setAuthToken).toHaveBeenCalledWith("fake-token");
    });

    it("should mark ready even when token read fails (non-auth daemon)", async () => {
      const config = mockConfig();
      const client = { setAuthToken: vi.fn(), healthCheck: vi.fn() } as unknown as WoprClient;
      client.healthCheck = vi.fn().mockResolvedValue(true);

      const fakeProcess = makeFakeProcess();
      vi.mocked(spawn).mockReturnValue(fakeProcess);
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const dm = new DaemonManager(config, client);
      await dm.start();

      // Still ready even though token read failed — daemon just doesn't use auth
      expect(dm.isReady()).toBe(true);
      expect(client.setAuthToken).not.toHaveBeenCalled();
    });
  });
});
