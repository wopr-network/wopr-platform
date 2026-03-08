import { describe, expect, it, vi } from "vitest";
import type { GpuConfiguration, IGpuConfigurationRepository } from "./gpu-configuration-repository.js";

describe("IGpuConfigurationRepository", () => {
  function makeMock(): IGpuConfigurationRepository {
    const store = new Map<string, GpuConfiguration>();
    return {
      list: vi.fn(async () => [...store.values()]),
      getByNodeId: vi.fn(async (gpuNodeId: string) => store.get(gpuNodeId) ?? null),
      upsert: vi.fn(async (config: Omit<GpuConfiguration, "updatedAt">) => {
        const now = Math.floor(Date.now() / 1000);
        const result: GpuConfiguration = { ...config, updatedAt: now };
        store.set(config.gpuNodeId, result);
        return result;
      }),
    };
  }

  it("upsert creates and list returns it", async () => {
    const repo = makeMock();
    const config = await repo.upsert({
      gpuNodeId: "gpu-1",
      memoryLimitMib: 8192,
      modelAssignments: ["whisper-large-v3"],
      maxConcurrency: 2,
      notes: null,
    });
    expect(config.gpuNodeId).toBe("gpu-1");
    const all = await repo.list();
    expect(all).toHaveLength(1);
  });

  it("getByNodeId returns null for missing", async () => {
    const repo = makeMock();
    const result = await repo.getByNodeId("nonexistent");
    expect(result).toBeNull();
  });

  it("upsert overwrites existing", async () => {
    const repo = makeMock();
    await repo.upsert({
      gpuNodeId: "gpu-1",
      memoryLimitMib: 8192,
      modelAssignments: ["whisper-large-v3"],
      maxConcurrency: 2,
      notes: null,
    });
    const updated = await repo.upsert({
      gpuNodeId: "gpu-1",
      memoryLimitMib: 16384,
      modelAssignments: ["whisper-large-v3", "piper-en"],
      maxConcurrency: 4,
      notes: "upgraded",
    });
    expect(updated.memoryLimitMib).toBe(16384);
    expect(updated.maxConcurrency).toBe(4);
    const all = await repo.list();
    expect(all).toHaveLength(1);
  });
});
