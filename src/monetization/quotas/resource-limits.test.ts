import { describe, expect, it } from "vitest";
import { buildResourceLimits, DEFAULT_RESOURCE_CONFIG, type ResourceConfig } from "./resource-limits.js";

const customConfig: ResourceConfig = {
  memoryLimitMb: 512,
  cpuQuota: 50_000,
  maxProcesses: 128,
};

describe("buildResourceLimits", () => {
  it("converts custom config to Docker resource constraints", () => {
    const limits = buildResourceLimits(customConfig);
    expect(limits.Memory).toBe(512 * 1024 * 1024); // 536870912 bytes
    expect(limits.CpuQuota).toBe(50_000);
    expect(limits.PidsLimit).toBe(128);
  });

  it("uses default config when no argument provided", () => {
    const limits = buildResourceLimits();
    expect(limits.Memory).toBe(DEFAULT_RESOURCE_CONFIG.memoryLimitMb * 1024 * 1024);
    expect(limits.CpuQuota).toBe(DEFAULT_RESOURCE_CONFIG.cpuQuota);
    expect(limits.PidsLimit).toBe(DEFAULT_RESOURCE_CONFIG.maxProcesses);
  });

  it("correctly calculates memory in bytes", () => {
    const limits = buildResourceLimits(customConfig);
    // 512 MB = 512 * 1024 * 1024 = 536870912
    expect(limits.Memory).toBe(536_870_912);
  });
});
