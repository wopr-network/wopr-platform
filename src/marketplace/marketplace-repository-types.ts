// Plain interfaces — NO Drizzle imports

export interface MarketplacePlugin {
  pluginId: string;
  npmPackage: string;
  version: string;
  enabled: boolean;
  featured: boolean;
  sortOrder: number;
  category: string | null;
  discoveredAt: number;
  enabledAt: number | null;
  enabledBy: string | null;
  notes: string | null;
  installedAt: number | null;
  installError: string | null;
}

export interface NewMarketplacePlugin {
  pluginId: string;
  npmPackage: string;
  version: string;
  category?: string | null;
  notes?: string | null;
}
