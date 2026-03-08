import { describe, expect, it, vi } from "vitest";
import type { GpuAllocation, IGpuAllocationRepository } from "./gpu-allocation-repository.js";

describe("IGpuAllocationRepository", () => {
  function makeMock(): IGpuAllocationRepository {
    const store = new Map<string, GpuAllocation>();
    return {
      list: vi.fn(async () => [...store.values()]),
      listByGpuNodeId: vi.fn(async (gpuNodeId: string) => [...store.values()].filter((a) => a.gpuNodeId === gpuNodeId)),
      listByTenantId: vi.fn(async (tenantId: string) => [...store.values()].filter((a) => a.tenantId === tenantId)),
      upsert: vi.fn(async (alloc: Omit<GpuAllocation, "createdAt" | "updatedAt">) => {
        const now = Math.floor(Date.now() / 1000);
        const existing = store.get(alloc.id);
        const result: GpuAllocation = {
          ...alloc,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        store.set(alloc.id, result);
        return result;
      }),
      delete: vi.fn(async (id: string) => {
        if (!store.has(id)) throw new Error(`Not found: ${id}`);
        store.delete(id);
      }),
    };
  }

  it("upsert creates and list returns it", async () => {
    const repo = makeMock();
    const alloc = await repo.upsert({
      id: "a1",
      gpuNodeId: "gpu-1",
      tenantId: "t1",
      botInstanceId: null,
      priority: "normal",
    });
    expect(alloc.id).toBe("a1");
    const all = await repo.list();
    expect(all).toHaveLength(1);
  });

  it("listByGpuNodeId filters correctly", async () => {
    const repo = makeMock();
    await repo.upsert({ id: "a1", gpuNodeId: "gpu-1", tenantId: "t1", botInstanceId: null, priority: "normal" });
    await repo.upsert({ id: "a2", gpuNodeId: "gpu-2", tenantId: "t2", botInstanceId: null, priority: "high" });
    const filtered = await repo.listByGpuNodeId("gpu-1");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].tenantId).toBe("t1");
  });

  it("delete removes allocation", async () => {
    const repo = makeMock();
    await repo.upsert({ id: "a1", gpuNodeId: "gpu-1", tenantId: "t1", botInstanceId: null, priority: "normal" });
    await repo.delete("a1");
    const all = await repo.list();
    expect(all).toHaveLength(0);
  });
});
