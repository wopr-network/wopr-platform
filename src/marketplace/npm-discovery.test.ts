import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IMarketplacePluginRepository } from "./marketplace-plugin-repository.js";
import type { MarketplacePlugin, NewMarketplacePlugin } from "./marketplace-repository-types.js";
import { discoverNpmPlugins } from "./npm-discovery.js";

function makeMockRepo(existing: Map<string, MarketplacePlugin> = new Map()) {
  const inserted: NewMarketplacePlugin[] = [];
  const repo: IMarketplacePluginRepository = {
    findAll: vi.fn(async () => []),
    findEnabled: vi.fn(async () => []),
    findPendingReview: vi.fn(async () => []),
    findById: vi.fn(async (id: string) => existing.get(id)),
    insert: vi.fn(async (p: NewMarketplacePlugin) => {
      inserted.push(p);
      return {
        pluginId: p.pluginId,
        npmPackage: p.npmPackage,
        version: p.version,
        enabled: false,
        featured: false,
        sortOrder: 0,
        category: null,
        discoveredAt: Date.now(),
        enabledAt: null,
        enabledBy: null,
        notes: null,
        installedAt: null,
        installError: null,
      } satisfies MarketplacePlugin;
    }),
    update: vi.fn(),
    delete: vi.fn(),
    setInstallResult: vi.fn(),
  };
  return { repo, inserted };
}

function fakeNpmResponse(packages: Array<{ name: string; version: string }>) {
  return new Response(
    JSON.stringify({
      objects: packages.map((p) => ({ package: p })),
      total: packages.length,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("discoverNpmPlugins", () => {
  let notifyMock: (message: string) => void;

  beforeEach(() => {
    notifyMock = vi.fn() as unknown as (message: string) => void;
  });

  it("discovers new plugins from npm search results", async () => {
    const { repo, inserted } = makeMockRepo();
    const fetcher = vi.fn(async () =>
      fakeNpmResponse([
        { name: "@wopr-network/wopr-plugin-foo", version: "1.0.0" },
        { name: "@wopr-network/wopr-plugin-bar", version: "2.1.0" },
      ]),
    );

    const result = await discoverNpmPlugins({ repo, notify: notifyMock, fetcher });

    expect(result).toEqual({ discovered: 2, skipped: 0 });
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toEqual({
      pluginId: "@wopr-network/wopr-plugin-foo",
      npmPackage: "@wopr-network/wopr-plugin-foo",
      version: "1.0.0",
    });
    expect(inserted[1]).toEqual({
      pluginId: "@wopr-network/wopr-plugin-bar",
      npmPackage: "@wopr-network/wopr-plugin-bar",
      version: "2.1.0",
    });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledWith("New plugin discovered: @wopr-network/wopr-plugin-foo@1.0.0");
    expect(notifyMock).toHaveBeenCalledWith("New plugin discovered: @wopr-network/wopr-plugin-bar@2.1.0");
  });

  it("skips plugins that already exist in the repository", async () => {
    const existing = new Map<string, MarketplacePlugin>([
      [
        "existing-plugin",
        {
          pluginId: "existing-plugin",
          npmPackage: "existing-plugin",
          version: "1.0.0",
          enabled: true,
          featured: false,
          sortOrder: 0,
          category: null,
          discoveredAt: 0,
          enabledAt: null,
          enabledBy: null,
          notes: null,
          installedAt: null,
          installError: null,
        },
      ],
    ]);
    const { repo, inserted } = makeMockRepo(existing);
    const fetcher = vi.fn(async () =>
      fakeNpmResponse([
        { name: "existing-plugin", version: "1.0.0" },
        { name: "new-plugin", version: "0.5.0" },
      ]),
    );

    const result = await discoverNpmPlugins({ repo, notify: notifyMock, fetcher });

    expect(result).toEqual({ discovered: 1, skipped: 1 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].pluginId).toBe("new-plugin");
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("returns error when npm registry returns non-ok status", async () => {
    const { repo } = makeMockRepo();
    const fetcher = vi.fn(async () => new Response("Internal Server Error", { status: 500 }));

    const result = await discoverNpmPlugins({ repo, notify: notifyMock, fetcher });

    expect(result).toEqual({
      discovered: 0,
      skipped: 0,
      error: "npm search API returned 500",
    });
    expect(repo.findById).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("returns error when npm registry returns 404", async () => {
    const { repo } = makeMockRepo();
    const fetcher = vi.fn(async () => new Response("Not Found", { status: 404 }));

    const result = await discoverNpmPlugins({ repo, notify: notifyMock, fetcher });

    expect(result.error).toBe("npm search API returned 404");
    expect(result.discovered).toBe(0);
  });

  it("returns error when fetch throws (network failure)", async () => {
    const { repo } = makeMockRepo();
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await discoverNpmPlugins({ repo, notify: notifyMock, fetcher });

    expect(result).toEqual({
      discovered: 0,
      skipped: 0,
      error: "npm search API failed: Error: ECONNREFUSED",
    });
    expect(repo.findById).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("handles empty search results", async () => {
    const { repo, inserted } = makeMockRepo();
    const fetcher = vi.fn(async () => fakeNpmResponse([]));

    const result = await discoverNpmPlugins({ repo, notify: notifyMock, fetcher });

    expect(result).toEqual({ discovered: 0, skipped: 0 });
    expect(inserted).toHaveLength(0);
    expect(repo.findById).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("handles all packages already existing (100% skip)", async () => {
    const makePlugin = (pluginId: string): MarketplacePlugin => ({
      pluginId,
      npmPackage: pluginId,
      version: "1.0.0",
      enabled: true,
      featured: false,
      sortOrder: 0,
      category: null,
      discoveredAt: 0,
      enabledAt: null,
      enabledBy: null,
      notes: null,
      installedAt: null,
      installError: null,
    });
    const existing = new Map<string, MarketplacePlugin>([
      ["a", makePlugin("a")],
      ["b", makePlugin("b")],
    ]);
    const { repo, inserted } = makeMockRepo(existing);
    const fetcher = vi.fn(async () =>
      fakeNpmResponse([
        { name: "a", version: "1.0.0" },
        { name: "b", version: "2.0.0" },
      ]),
    );

    const result = await discoverNpmPlugins({ repo, notify: notifyMock, fetcher });

    expect(result).toEqual({ discovered: 0, skipped: 2 });
    expect(inserted).toHaveLength(0);
    expect(repo.insert).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("calls fetcher with the correct npm search URL", async () => {
    const { repo } = makeMockRepo();
    const fetcher = vi.fn(async () => fakeNpmResponse([]));

    await discoverNpmPlugins({ repo, notify: notifyMock, fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("https://registry.npmjs.org/-/v1/search?text=keywords:wopr-plugin&size=250");
  });
});
