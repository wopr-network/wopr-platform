import type { PlanTier } from "./tier-definitions.js";

/** Docker HostConfig resource constraints derived from a plan tier */
export interface ContainerResourceLimits {
  Memory: number; // bytes
  CpuQuota: number; // microseconds per CpuPeriod (default period 100000)
  PidsLimit: number;
}

/** Convert a plan tier's limits into Docker HostConfig resource constraints */
export function buildResourceLimits(tier: PlanTier): ContainerResourceLimits {
  return {
    Memory: tier.memoryLimitMb * 1024 * 1024, // MB to bytes
    CpuQuota: tier.cpuQuota,
    PidsLimit: tier.maxProcesses,
  };
}
