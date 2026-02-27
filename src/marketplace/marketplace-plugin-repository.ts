import type { MarketplacePlugin, NewMarketplacePlugin } from "./marketplace-repository-types.js";

export type { MarketplacePlugin, NewMarketplacePlugin };

export interface IMarketplacePluginRepository {
  findAll(): Promise<MarketplacePlugin[]>;
  findEnabled(): Promise<MarketplacePlugin[]>;
  findPendingReview(): Promise<MarketplacePlugin[]>;
  findById(pluginId: string): Promise<MarketplacePlugin | undefined>;
  insert(plugin: NewMarketplacePlugin): Promise<MarketplacePlugin>;
  update(pluginId: string, patch: Partial<MarketplacePlugin>): Promise<MarketplacePlugin>;
  delete(pluginId: string): Promise<void>;
  setInstallResult(pluginId: string, installedAt: number | null, installError: string | null): Promise<void>;
}
