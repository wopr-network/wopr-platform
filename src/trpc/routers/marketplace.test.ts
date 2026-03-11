import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMarketplacePluginRepository } from "../../marketplace/marketplace-plugin-repository.js";
import type { MarketplacePlugin } from "../../marketplace/marketplace-repository-types.js";
import { marketplaceRouter, setMarketplaceRouterDeps } from "./marketplace.js";

vi.mock("../../marketplace/volume-installer.js", () => ({
  upgradePluginOnVolume: vi.fn().mockResolvedValue(undefined),
  rollbackPluginOnVolume: vi.fn().mockResolvedValue(undefined),
}));

import { rollbackPluginOnVolume, upgradePluginOnVolume } from "../../marketplace/volume-installer.js";

function makePlugin(overrides: Partial<MarketplacePlugin> = {}): MarketplacePlugin {
  return {
    pluginId: "test-plugin",
    npmPackage: "@wopr/test-plugin",
    version: "1.0.0",
    previousVersion: null,
    enabled: true,
    featured: false,
    sortOrder: 0,
    category: null,
    discoveredAt: Date.now(),
    enabledAt: null,
    enabledBy: null,
    notes: null,
    installedAt: null,
    installError: null,
    manifest: null,
    ...overrides,
  };
}

type CallerCtx = Parameters<typeof marketplaceRouter.createCaller>[0];

function adminCtx(): CallerCtx {
  return {
    user: { id: "admin-1", roles: ["platform_admin"] },
    tenantId: undefined,
  };
}

describe("marketplaceRouter", () => {
  let mockRepo: Record<keyof IMarketplacePluginRepository, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    mockRepo = {
      findAll: vi.fn(),
      findEnabled: vi.fn(),
      findPendingReview: vi.fn(),
      findById: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      setInstallResult: vi.fn(),
      setVersion: vi.fn(),
    };
    setMarketplaceRouterDeps({
      getMarketplacePluginRepo: () => mockRepo as unknown as IMarketplacePluginRepository,
      getPluginVolumePath: () => "/tmp/test-volume",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("upgrade", () => {
    it("should upgrade a plugin and return the updated record", async () => {
      const plugin = makePlugin();
      const updated = makePlugin({ version: "2.0.0", previousVersion: "1.0.0" });
      mockRepo.findById.mockResolvedValueOnce(plugin).mockResolvedValueOnce(updated);

      const caller = marketplaceRouter.createCaller(adminCtx());
      const result = await caller.upgrade({ pluginId: "test-plugin", targetVersion: "2.0.0" });

      expect(mockRepo.findById).toHaveBeenCalledWith("test-plugin");
      expect(upgradePluginOnVolume).toHaveBeenCalledWith({
        pluginId: "test-plugin",
        npmPackage: "@wopr/test-plugin",
        targetVersion: "2.0.0",
        volumePath: "/tmp/test-volume",
        repo: mockRepo,
      });
      expect(result).toEqual(updated);
    });

    it("should throw NOT_FOUND when plugin does not exist", async () => {
      mockRepo.findById.mockResolvedValue(undefined);

      const caller = marketplaceRouter.createCaller(adminCtx());
      await expect(caller.upgrade({ pluginId: "missing", targetVersion: "1.0.0" })).rejects.toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    });
  });

  describe("rollback", () => {
    it("should rollback a plugin and return the updated record", async () => {
      const plugin = makePlugin({ previousVersion: "0.9.0" });
      const rolledBack = makePlugin({ version: "0.9.0", previousVersion: null });
      mockRepo.findById.mockResolvedValueOnce(plugin).mockResolvedValueOnce(rolledBack);

      const caller = marketplaceRouter.createCaller(adminCtx());
      const result = await caller.rollback({ pluginId: "test-plugin" });

      expect(rollbackPluginOnVolume).toHaveBeenCalledWith({
        pluginId: "test-plugin",
        npmPackage: "@wopr/test-plugin",
        previousVersion: "0.9.0",
        volumePath: "/tmp/test-volume",
        repo: mockRepo,
      });
      expect(result).toEqual(rolledBack);
    });

    it("should throw NOT_FOUND when plugin does not exist", async () => {
      mockRepo.findById.mockResolvedValue(undefined);

      const caller = marketplaceRouter.createCaller(adminCtx());
      await expect(caller.rollback({ pluginId: "missing" })).rejects.toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    });

    it("should throw BAD_REQUEST when no previous version exists", async () => {
      const plugin = makePlugin({ previousVersion: null });
      mockRepo.findById.mockResolvedValue(plugin);

      const caller = marketplaceRouter.createCaller(adminCtx());
      await expect(caller.rollback({ pluginId: "test-plugin" })).rejects.toThrow(
        expect.objectContaining({ code: "BAD_REQUEST" }),
      );
    });
  });
});
