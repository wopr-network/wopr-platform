import { readFile as fsReadFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IMarketplaceContentRepository } from "./marketplace-content-repository.js";

interface FsAdapters {
  readFile: (path: string) => Promise<string>;
  resolvePkg: (pkgName: string) => string;
}

const defaultAdapters: FsAdapters = {
  readFile: (path) => fsReadFile(path, "utf-8"),
  resolvePkg: (pkgName) => {
    const require = createRequire(import.meta.url);
    return require.resolve(`${pkgName}/package.json`);
  },
};

/**
 * Extract SUPERPOWER.md from a plugin's npm package directory and cache it.
 * Falls back to manifest.description if the file is absent.
 * Skips extraction if the cached version matches.
 */
export async function extractPluginContent(
  pluginId: string,
  version: string,
  manifestDescription: string,
  repo: IMarketplaceContentRepository,
  adapters: FsAdapters = defaultAdapters,
): Promise<void> {
  // Skip if already cached at this version
  const existing = repo.getByPluginId(pluginId);
  if (existing && existing.version === version) return;

  const npmPkgName = `@wopr-network/wopr-plugin-${pluginId}`;

  let markdown: string;
  let source: "superpower_md" | "manifest_description";

  try {
    const pkgJsonPath = adapters.resolvePkg(npmPkgName);
    const pkgDir = dirname(pkgJsonPath);
    const superpowerPath = join(pkgDir, "SUPERPOWER.md");
    markdown = await adapters.readFile(superpowerPath);
    source = "superpower_md";
  } catch {
    // SUPERPOWER.md not found or package not resolvable — use manifest description
    markdown = manifestDescription;
    source = "manifest_description";
  }

  repo.upsert({
    pluginId,
    version,
    markdown,
    source,
    updatedAt: Date.now(),
  });
}
