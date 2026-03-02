// Plain interfaces — NO Drizzle imports

export interface MarketplacePluginManifest {
  name: string;
  description: string;
  author: string;
  icon: string;
  color: string;
  tags: string[];
  capabilities: string[];
  requires: { id: string; label: string }[];
  install: string[];
  configSchema: {
    key: string;
    label: string;
    type: "string" | "number" | "boolean" | "select";
    required: boolean;
    secret?: boolean;
    env?: string;
    placeholder?: string;
    description?: string;
    default?: string | number | boolean;
    options?: { label: string; value: string }[];
    validation?: { pattern: string; message: string };
  }[];
  setup: {
    id: string;
    title: string;
    description: string;
    fields: {
      key: string;
      label: string;
      type: "string" | "number" | "boolean" | "select";
      required: boolean;
      secret?: boolean;
      placeholder?: string;
      options?: { label: string; value: string }[];
      validation?: { pattern: string; message: string };
    }[];
    instruction?: string;
    externalUrl?: string;
  }[];
  installCount: number;
  changelog: { version: string; date: string; notes: string }[];
}

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
  manifest: MarketplacePluginManifest | null;
}

export interface NewMarketplacePlugin {
  pluginId: string;
  npmPackage: string;
  version: string;
  category?: string | null;
  notes?: string | null;
  manifest?: MarketplacePluginManifest | null;
}
