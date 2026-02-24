export const STORAGE_TIERS = {
  standard: {
    label: "Standard",
    storageLimitGb: 5,
    dailyCostCents: 0,
    description: "5 GB — included with your bot",
  },
  plus: {
    label: "Plus",
    storageLimitGb: 20,
    dailyCostCents: 3,
    description: "20 GB — for bots with browser automation or file processing",
  },
  pro: {
    label: "Pro",
    storageLimitGb: 50,
    dailyCostCents: 8,
    description: "50 GB — for semantic memory and large datasets",
  },
  max: {
    label: "Max",
    storageLimitGb: 100,
    dailyCostCents: 15,
    description: "100 GB — maximum storage capacity",
  },
} as const;

export type StorageTierKey = keyof typeof STORAGE_TIERS;
export const STORAGE_TIER_KEYS = Object.keys(STORAGE_TIERS) as StorageTierKey[];
export const DEFAULT_STORAGE_TIER: StorageTierKey = "standard";
