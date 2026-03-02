import { describe, expect, it, vi } from "vitest";
import type { IMarketplacePluginRepository } from "./marketplace-plugin-repository.js";
import type { MarketplacePlugin } from "./marketplace-repository-types.js";
import { installPluginToVolume, rollbackPluginOnVolume, upgradePluginOnVolume } from "./volume-installer.js";

function makePlugin(overrides: Partial<MarketplacePlugin> = {}): MarketplacePlugin {
  return {
    pluginId: "test-plugin",
    npmPackage: "@wopr-network/wopr-plugin-test",
    version: "1.0.0",
    previousVersion: null,
    enabled: true,
    featured: false,
    sortOrder: 999,
    category: null,
    discoveredAt: Date.now(),
    enabledAt: null,
    enabledBy: null,
    notes: null,
    installedAt: Date.now(),
    installError: null,
    ...overrides,
  };
}

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
    setVersion: vi.fn().mockResolvedValue(undefined),
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

describe("upgradePluginOnVolume", () => {
  it("installs target version and records previous version", async () => {
    const setInstallResult = vi.fn().mockResolvedValue(undefined);
    const setVersion = vi.fn().mockResolvedValue(undefined);
    const plugin = makePlugin({ version: "1.0.0" });
    const repo = mockRepo({
      findById: vi.fn().mockResolvedValue(plugin),
      setInstallResult,
      setVersion,
    });
    const execFn = vi
      .fn()
      .mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: (err: null, stdout: string, stderr: string) => void) => {
          cb(null, "added 1 package", "");
        },
      );

    await upgradePluginOnVolume({
      pluginId: "test-plugin",
      npmPackage: "@wopr-network/wopr-plugin-test",
      targetVersion: "2.0.0",
      volumePath: "/tmp/test-plugins",
      repo,
      execFn: execFn as never,
    });

    expect(execFn).toHaveBeenCalledWith(
      "npm",
      ["install", "@wopr-network/wopr-plugin-test@2.0.0"],
      expect.objectContaining({ cwd: "/tmp/test-plugins" }),
      expect.any(Function),
    );
    expect(setVersion).toHaveBeenCalledWith("test-plugin", "2.0.0", "1.0.0");
    expect(setInstallResult).toHaveBeenCalledWith("test-plugin", expect.any(Number), null);
  });

  it("throws and records error when npm install fails", async () => {
    const setInstallResult = vi.fn().mockResolvedValue(undefined);
    const plugin = makePlugin({ version: "1.0.0" });
    const repo = mockRepo({
      findById: vi.fn().mockResolvedValue(plugin),
      setInstallResult,
    });
    const execFn = vi
      .fn()
      .mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: (err: Error, stdout: string, stderr: string) => void) => {
          cb(new Error("npm ERR!"), "", "npm ERR!");
        },
      );

    await expect(
      upgradePluginOnVolume({
        pluginId: "test-plugin",
        npmPackage: "@wopr-network/wopr-plugin-test",
        targetVersion: "2.0.0",
        volumePath: "/tmp/test-plugins",
        repo,
        execFn: execFn as never,
      }),
    ).rejects.toThrow();
    expect(setInstallResult).toHaveBeenCalledWith("test-plugin", null, expect.stringContaining("npm ERR!"));
  });

  it("throws NOT_FOUND when plugin does not exist", async () => {
    const repo = mockRepo({ findById: vi.fn().mockResolvedValue(undefined) });
    await expect(
      upgradePluginOnVolume({
        pluginId: "missing",
        npmPackage: "@wopr-network/wopr-plugin-test",
        targetVersion: "2.0.0",
        volumePath: "/tmp/test-plugins",
        repo,
      }),
    ).rejects.toThrow("Plugin not found: missing");
  });
});

describe("rollbackPluginOnVolume", () => {
  it("installs previous version and clears previousVersion", async () => {
    const setInstallResult = vi.fn().mockResolvedValue(undefined);
    const setVersion = vi.fn().mockResolvedValue(undefined);
    const plugin = makePlugin({ version: "2.0.0", previousVersion: "1.0.0" });
    const repo = mockRepo({
      findById: vi.fn().mockResolvedValue(plugin),
      setInstallResult,
      setVersion,
    });
    const execFn = vi
      .fn()
      .mockImplementation(
        (_cmd: string, _args: string[], _opts: object, cb: (err: null, stdout: string, stderr: string) => void) => {
          cb(null, "added 1 package", "");
        },
      );

    await rollbackPluginOnVolume({
      pluginId: "test-plugin",
      npmPackage: "@wopr-network/wopr-plugin-test",
      previousVersion: "1.0.0",
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
    expect(setVersion).toHaveBeenCalledWith("test-plugin", "1.0.0", null);
    expect(setInstallResult).toHaveBeenCalledWith("test-plugin", expect.any(Number), null);
  });

  it("throws NOT_FOUND when plugin does not exist", async () => {
    const repo = mockRepo({ findById: vi.fn().mockResolvedValue(undefined) });
    await expect(
      rollbackPluginOnVolume({
        pluginId: "missing",
        npmPackage: "@wopr-network/wopr-plugin-test",
        previousVersion: "1.0.0",
        volumePath: "/tmp/test-plugins",
        repo,
      }),
    ).rejects.toThrow("Plugin not found: missing");
  });
});
