/** Docker HostConfig resource constraints for bot containers. */
export interface ContainerResourceLimits {
  Memory: number; // bytes
  CpuQuota: number; // microseconds per CpuPeriod (default period 100000)
  PidsLimit: number;
}

/**
 * Resource configuration for container limits.
 * Replaces the old PlanTier dependency — callers pass limits directly.
 */
export interface ResourceConfig {
  memoryLimitMb: number;
  cpuQuota: number;
  maxProcesses: number;
}

/** Default resource config for credit-based billing. */
export const DEFAULT_RESOURCE_CONFIG: ResourceConfig = {
  memoryLimitMb: 2048,
  cpuQuota: 200_000, // 2 CPUs
  maxProcesses: 512,
};

/** Convert resource config into Docker HostConfig resource constraints. */
export function buildResourceLimits(config: ResourceConfig = DEFAULT_RESOURCE_CONFIG): ContainerResourceLimits {
  return {
    Memory: config.memoryLimitMb * 1024 * 1024, // MB to bytes
    CpuQuota: config.cpuQuota,
    PidsLimit: config.maxProcesses,
  };
}
