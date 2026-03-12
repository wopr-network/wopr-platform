import type {
  GpuAllocation,
  IGpuAllocationRepository,
} from "@wopr-network/platform-core/fleet/gpu-allocation-repository";
import type {
  GpuConfiguration,
  IGpuConfigurationRepository,
} from "@wopr-network/platform-core/fleet/gpu-configuration-repository";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminRouterDeps } from "./admin.js";
import { adminRouter, setAdminRouterDeps } from "./admin.js";

function makeMockAllocationRepo(): IGpuAllocationRepository {
  const store = new Map<string, GpuAllocation>();
  return {
    list: vi.fn(async () => [...store.values()]),
    listByGpuNodeId: vi.fn(async (id: string) => [...store.values()].filter((a) => a.gpuNodeId === id)),
    listByTenantId: vi.fn(async (id: string) => [...store.values()].filter((a) => a.tenantId === id)),
    upsert: vi.fn(async (alloc) => {
      const now = Math.floor(Date.now() / 1000);
      const result: GpuAllocation = { ...alloc, createdAt: now, updatedAt: now };
      store.set(alloc.id, result);
      return result;
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
  };
}

function makeMockConfigRepo(): IGpuConfigurationRepository {
  const store = new Map<string, GpuConfiguration>();
  return {
    list: vi.fn(async () => [...store.values()]),
    getByNodeId: vi.fn(async (id: string) => store.get(id) ?? null),
    upsert: vi.fn(async (config) => {
      const now = Math.floor(Date.now() / 1000);
      const result: GpuConfiguration = { ...config, updatedAt: now };
      store.set(config.gpuNodeId, result);
      return result;
    }),
  };
}

function makeMockAuditLog() {
  return {
    query: vi.fn().mockReturnValue({ entries: [], total: 0 }),
    exportCsv: vi.fn(),
    log: vi.fn(),
  } as unknown as import("@wopr-network/platform-core/admin").AdminAuditLog;
}

function makeDeps(): AdminRouterDeps {
  return {
    getAuditLog: () => makeMockAuditLog(),
    getCreditLedger: () =>
      ({
        balance: vi.fn(),
        credit: vi.fn(),
        debit: vi.fn(),
        hasReferenceId: vi.fn(),
        history: vi.fn(),
        tenantsWithBalance: vi.fn(),
        expiredCredits: vi.fn(),
        memberUsage: vi.fn(),
      }) as unknown as import("@wopr-network/platform-core/credits").ICreditLedger,
    getUserStore: () =>
      ({ list: vi.fn(), getById: vi.fn() }) as unknown as import("../../admin/users/user-store.js").AdminUserStore,
    getTenantStatusStore: () =>
      ({
        get: vi.fn(),
        getStatus: vi.fn(),
        suspend: vi.fn(),
        reactivate: vi.fn(),
        ban: vi.fn(),
        list: vi.fn(),
      }) as unknown as import("../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
    getGpuAllocationRepo: () => makeMockAllocationRepo(),
    getGpuConfigurationRepo: () => makeMockConfigRepo(),
  };
}

type CallerCtx = Parameters<typeof adminRouter.createCaller>[0];

function adminCtx(): CallerCtx {
  return { user: { id: "admin-1", roles: ["platform_admin"] }, tenantId: undefined };
}

describe("admin.gpuAllocations", () => {
  beforeEach(() => {
    setAdminRouterDeps(makeDeps());
  });

  it("returns empty list initially", async () => {
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.gpuAllocations();
    expect(result).toEqual([]);
  });
});

describe("admin.updateGpuAllocation", () => {
  beforeEach(() => {
    setAdminRouterDeps(makeDeps());
  });

  it("creates a new allocation", async () => {
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.updateGpuAllocation({
      id: "a1",
      gpuNodeId: "gpu-1",
      tenantId: "t1",
      botInstanceId: null,
      priority: "normal",
    });
    expect(result.id).toBe("a1");
    expect(result.gpuNodeId).toBe("gpu-1");
  });

  it("rejects invalid priority", async () => {
    const caller = adminRouter.createCaller(adminCtx());
    await expect(
      caller.updateGpuAllocation({
        id: "a1",
        gpuNodeId: "gpu-1",
        tenantId: "t1",
        botInstanceId: null,
        priority: "invalid" as "low",
      }),
    ).rejects.toThrow();
  });
});

describe("admin.gpuConfigurations", () => {
  beforeEach(() => {
    setAdminRouterDeps(makeDeps());
  });

  it("returns empty list initially", async () => {
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.gpuConfigurations();
    expect(result).toEqual([]);
  });
});

describe("admin.updateGpuConfiguration", () => {
  beforeEach(() => {
    setAdminRouterDeps(makeDeps());
  });

  it("upserts a configuration", async () => {
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.updateGpuConfiguration({
      gpuNodeId: "gpu-1",
      memoryLimitMib: 8192,
      modelAssignments: ["whisper-large-v3"],
      maxConcurrency: 2,
      notes: null,
    });
    expect(result.gpuNodeId).toBe("gpu-1");
    expect(result.maxConcurrency).toBe(2);
  });

  it("rejects maxConcurrency < 1", async () => {
    const caller = adminRouter.createCaller(adminCtx());
    await expect(
      caller.updateGpuConfiguration({
        gpuNodeId: "gpu-1",
        memoryLimitMib: null,
        modelAssignments: [],
        maxConcurrency: 0,
        notes: null,
      }),
    ).rejects.toThrow();
  });
});
