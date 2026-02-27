import { describe, expect, it, vi } from "vitest";
import type { IMarketplacePluginRepository } from "./marketplace-plugin-repository.js";
import { installPluginToVolume } from "./volume-installer.js";

function mockRepo(overrides: Partial<IMarketplacePluginRepository> = {}): IMarketplacePluginRepository {
  return {
    findAll: vi.fn().mockResolvedValue([]),
    findEnabled: vi.fn().mockResolvedValue([]),
    findPendingReview: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue({} as never),
    update: vi.fn().mockResolvedValue({} as never),
    delete: vi.fn().mockResolvedValue(undefined),
    setInstallResult: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("installPluginToVolume", () => {
  it("calls npm install and records installedAt on success", async () => {
    const setInstallResult = vi.fn().mockResolvedValue(undefined);
    const repo = mockRepo({ setInstallResult });
    const execFn = vi
      .fn()
      .mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: (err: null, stdout: string, stderr: string) => void) => {
          cb(null, "added 1 package", "");
        },
      );

    await installPluginToVolume({
      pluginId: "test-plugin",
      npmPackage: "@wopr-network/wopr-plugin-test",
      version: "1.0.0",
      volumePath: "/tmp/test-plugins",
      repo,
      execFn: execFn as never,
    });

    expect(execFn).toHaveBeenCalledWith(
      "npm",
      ["install", "@wopr-network/wopr-plugin-test@1.0.0"],
      expect.objectContaining({ cwd: "/tmp/test-plugins" }),
      expect.any(Function),
    );
    expect(setInstallResult).toHaveBeenCalledWith("test-plugin", expect.any(Number), null);
  });

  it("records installError on npm failure", async () => {
    const setInstallResult = vi.fn().mockResolvedValue(undefined);
    const repo = mockRepo({ setInstallResult });
    const execFn = vi
      .fn()
      .mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: (err: Error, stdout: string, stderr: string) => void) => {
          cb(new Error("npm ERR! 404 Not Found"), "", "npm ERR! 404 Not Found");
        },
      );

    await installPluginToVolume({
      pluginId: "bad-plugin",
      npmPackage: "@wopr-network/wopr-plugin-bad",
      version: "0.0.1",
      volumePath: "/tmp/test-plugins",
      repo,
      execFn: execFn as never,
    });

    expect(setInstallResult).toHaveBeenCalledWith("bad-plugin", null, expect.stringContaining("npm ERR!"));
  });
});
