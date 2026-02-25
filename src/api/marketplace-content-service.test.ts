import { describe, expect, it, vi } from "vitest";
import type { IMarketplaceContentRepository } from "./marketplace-content-repository.js";
import { extractPluginContent } from "./marketplace-content-service.js";

describe("extractPluginContent", () => {
  it("reads SUPERPOWER.md when it exists", async () => {
    const mockRepo: IMarketplaceContentRepository = {
      getByPluginId: vi.fn().mockReturnValue(null),
      upsert: vi.fn(),
    };

    const mockReadFile = vi
      .fn()
      .mockResolvedValue("# Secretary\n*Your AI executive assistant*\n\n## What she can do\n- Schedule meetings");
    const mockResolve = vi.fn().mockReturnValue("/fake/node_modules/@wopr-network/wopr-plugin-secretary/package.json");

    await extractPluginContent("secretary", "1.0.0", "A basic description", mockRepo, {
      readFile: mockReadFile,
      resolvePkg: mockResolve,
    });

    expect(mockRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "secretary",
        version: "1.0.0",
        source: "superpower_md",
        markdown: expect.stringContaining("# Secretary"),
      }),
    );
  });

  it("falls back to manifest.description when SUPERPOWER.md absent", async () => {
    const mockRepo: IMarketplaceContentRepository = {
      getByPluginId: vi.fn().mockReturnValue(null),
      upsert: vi.fn(),
    };

    const mockReadFile = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const mockResolve = vi.fn().mockReturnValue("/fake/node_modules/@wopr-network/wopr-plugin-secretary/package.json");

    await extractPluginContent("secretary", "1.0.0", "A basic description", mockRepo, {
      readFile: mockReadFile,
      resolvePkg: mockResolve,
    });

    expect(mockRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "secretary",
        source: "manifest_description",
        markdown: "A basic description",
      }),
    );
  });

  it("skips extraction when version matches cached", async () => {
    const mockRepo: IMarketplaceContentRepository = {
      getByPluginId: vi.fn().mockReturnValue({
        pluginId: "secretary",
        version: "1.0.0",
        markdown: "# Cached",
        source: "superpower_md",
        updatedAt: Date.now(),
      }),
      upsert: vi.fn(),
    };

    const mockReadFile = vi.fn();
    const mockResolve = vi.fn();

    await extractPluginContent("secretary", "1.0.0", "desc", mockRepo, {
      readFile: mockReadFile,
      resolvePkg: mockResolve,
    });

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockRepo.upsert).not.toHaveBeenCalled();
  });
});
