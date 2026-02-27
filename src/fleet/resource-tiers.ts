import { Credit } from "../monetization/credit.js";
import type { ContainerResourceLimits } from "../monetization/quotas/resource-limits.js";

export const RESOURCE_TIERS = {
  standard: {
    label: "Standard",
    memoryLimitMb: 2048,
    cpuQuota: 200_000,
    maxProcesses: 512,
    dailyCost: Credit.ZERO,
    description: "2 GB RAM, 2 vCPU — included with your bot",
  },
  pro: {
    label: "Pro",
    memoryLimitMb: 4096,
    cpuQuota: 400_000,
    maxProcesses: 1024,
    dailyCost: Credit.fromCents(10),
    description: "4 GB RAM, 4 vCPU — for heavier workloads",
  },
  power: {
    label: "Power",
    memoryLimitMb: 8192,
    cpuQuota: 600_000,
    maxProcesses: 2048,
    dailyCost: Credit.fromCents(27),
    description: "8 GB RAM, 6 vCPU — for power users",
  },
  beast: {
    label: "Beast",
    memoryLimitMb: 16384,
    cpuQuota: 800_000,
    maxProcesses: 4096,
    dailyCost: Credit.fromCents(50),
    description: "16 GB RAM, 8 vCPU — maximum performance",
  },
};

export type ResourceTierKey = keyof typeof RESOURCE_TIERS;
export const RESOURCE_TIER_KEYS = Object.keys(RESOURCE_TIERS) as ResourceTierKey[];
export const DEFAULT_RESOURCE_TIER: ResourceTierKey = "standard";

export function tierToResourceLimits(tier: ResourceTierKey): ContainerResourceLimits {
  const cfg = RESOURCE_TIERS[tier];
  return {
    Memory: cfg.memoryLimitMb * 1024 * 1024,
    CpuQuota: cfg.cpuQuota,
    PidsLimit: cfg.maxProcesses,
  };
}
