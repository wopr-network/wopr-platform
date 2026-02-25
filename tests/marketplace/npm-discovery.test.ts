import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IMarketplacePluginRepository } from "../../src/marketplace/marketplace-plugin-repository.js";
import type { MarketplacePlugin, NewMarketplacePlugin } from "../../src/marketplace/marketplace-repository-types.js";
import { discoverNpmPlugins } from "../../src/marketplace/npm-discovery.js";

function makeMockRepo(): IMarketplacePluginRepository {
  const store = new Map<string, MarketplacePlugin>();
  return {
    findAll: () => [...store.values()],
    findEnabled: () => [...store.values()].filter((p) => p.enabled),
    findPendingReview: () => [...store.values()].filter((p) => !p.enabled),
    findById: (id: string) => store.get(id),
    insert: (p: NewMarketplacePlugin) => {
      const plugin: MarketplacePlugin = {
        pluginId: p.pluginId,
        npmPackage: p.npmPackage,
        version: p.version,
        enabled: false,
        featured: false,
        sortOrder: 999,
        category: p.category ?? null,
        discoveredAt: Date.now(),
        enabledAt: null,
        enabledBy: null,
        notes: p.notes ?? null,
      };
      store.set(p.pluginId, plugin);
      return plugin;
    },
    update: vi.fn() as IMarketplacePluginRepository["update"],
    delete: vi.fn() as IMarketplacePluginRepository["delete"],
  };
}

function makeNpmResponse(packages: Array<{ name: string; version: string; keywords?: string[] }>) {
  return {
    objects: packages.map((p) => ({
      package: {
        name: p.name,
        version: p.version,
        keywords: p.keywords ?? ["wopr-plugin"],
        description: "A WOPR plugin",
      },
    })),
    total: packages.length,
  };
}

describe("discoverNpmPlugins", () => {
  let repo: IMarketplacePluginRepository;
  let notifyFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    repo = makeMockRepo();
    notifyFn = vi.fn();
  });

  it("inserts newly discovered packages", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        makeNpmResponse([{ name: "@wopr-network/wopr-plugin-discord", version: "3.2.0" }]),
    });

    const result = await discoverNpmPlugins({ repo, notify: notifyFn, fetcher });
    expect(result.discovered).toBe(1);
    expect(result.skipped).toBe(0);
    expect(repo.findAll()).toHaveLength(1);
    expect(notifyFn).toHaveBeenCalledTimes(1);
  });

  it("skips already-known packages", async () => {
    repo.insert({
      pluginId: "@wopr-network/wopr-plugin-discord",
      npmPackage: "@wopr-network/wopr-plugin-discord",
      version: "3.2.0",
    });

    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        makeNpmResponse([{ name: "@wopr-network/wopr-plugin-discord", version: "3.2.0" }]),
    });

    const result = await discoverNpmPlugins({ repo, notify: notifyFn, fetcher });
    expect(result.discovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("handles npm API failure gracefully", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const result = await discoverNpmPlugins({ repo, notify: notifyFn, fetcher });
    expect(result.discovered).toBe(0);
    expect(result.error).toBeDefined();
  });
});
