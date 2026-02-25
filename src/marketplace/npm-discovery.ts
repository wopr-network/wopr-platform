import { logger } from "../config/logger.js";
import type { IMarketplacePluginRepository } from "./marketplace-plugin-repository.js";

const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search?text=keywords:wopr-plugin&size=250";

interface NpmSearchResult {
  objects: Array<{
    package: {
      name: string;
      version: string;
      keywords?: string[];
      description?: string;
    };
  }>;
  total: number;
}

export interface DiscoveryOptions {
  repo: IMarketplacePluginRepository;
  notify: (message: string) => void;
  fetcher?: typeof fetch;
}

export interface DiscoveryResult {
  discovered: number;
  skipped: number;
  error?: string;
}

export async function discoverNpmPlugins(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const { repo, notify, fetcher = fetch } = options;

  let data: NpmSearchResult;
  try {
    const response = await fetcher(NPM_SEARCH_URL);
    if (!response.ok) {
      const msg = `npm search API returned ${response.status}`;
      logger.warn(msg);
      return { discovered: 0, skipped: 0, error: msg };
    }
    data = (await response.json()) as NpmSearchResult;
  } catch (err) {
    const msg = `npm search API failed: ${err}`;
    logger.error(msg);
    return { discovered: 0, skipped: 0, error: msg };
  }

  let discovered = 0;
  let skipped = 0;

  for (const obj of data.objects) {
    const pkg = obj.package;
    const existing = repo.findById(pkg.name);
    if (existing) {
      skipped++;
      continue;
    }

    repo.insert({
      pluginId: pkg.name,
      npmPackage: pkg.name,
      version: pkg.version,
    });
    discovered++;

    notify(`New plugin discovered: ${pkg.name}@${pkg.version}`);
    logger.info("Marketplace: discovered new plugin", { name: pkg.name, version: pkg.version });
  }

  return { discovered, skipped };
}
