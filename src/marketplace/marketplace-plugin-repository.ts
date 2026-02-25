import type { MarketplacePlugin, NewMarketplacePlugin } from "./marketplace-repository-types.js";

export type { MarketplacePlugin, NewMarketplacePlugin };

export interface IMarketplacePluginRepository {
  findAll(): MarketplacePlugin[];
  findEnabled(): MarketplacePlugin[];
  findPendingReview(): MarketplacePlugin[];
  findById(pluginId: string): MarketplacePlugin | undefined;
  insert(plugin: NewMarketplacePlugin): MarketplacePlugin;
  update(pluginId: string, patch: Partial<MarketplacePlugin>): MarketplacePlugin;
  delete(pluginId: string): void;
}
