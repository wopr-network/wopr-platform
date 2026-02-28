import { Credit } from "../credit.js";

export const ADDON_KEYS = ["gpu_acceleration", "priority_queue", "extra_storage", "custom_domain"] as const;

export type AddonKey = (typeof ADDON_KEYS)[number];

export interface AddonDefinition {
  key: AddonKey;
  label: string;
  dailyCost: Credit;
  description: string;
}

export const ADDON_CATALOG: Record<AddonKey, AddonDefinition> = {
  gpu_acceleration: {
    key: "gpu_acceleration",
    label: "GPU Acceleration",
    dailyCost: Credit.fromCents(50),
    description: "GPU-backed inference for faster, higher-quality responses",
  },
  priority_queue: {
    key: "priority_queue",
    label: "Priority Queue",
    dailyCost: Credit.fromCents(20),
    description: "Skip the queue for faster response times",
  },
  extra_storage: {
    key: "extra_storage",
    label: "Extra Storage",
    dailyCost: Credit.fromCents(10),
    description: "Additional bot data storage beyond your tier limit",
  },
  custom_domain: {
    key: "custom_domain",
    label: "Custom Domain",
    dailyCost: Credit.fromCents(5),
    description: "Use your own domain for bot URLs",
  },
};
