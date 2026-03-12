import type { DeletionRequestRow } from "@wopr-network/platform-core/account/repository-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAccountDeletionStore } from "../../../account/deletion-store.js";
import type { AdminRouterDeps } from "../admin.js";
import { adminRouter, setAdminRouterDeps } from "../admin.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const mockDeletionRequest: DeletionRequestRow = {
  id: "del-1",
  tenantId: "t-1",
  requestedBy: "admin-1",
  status: "pending",
  deleteAfter: "2026-04-07T00:00:00.000Z",
  reason: null,
  cancelReason: null,
  completedAt: null,
  deletionSummary: null,
  createdAt: "2026-03-08T00:00:00.000Z",
  updatedAt: "2026-03-08T00:00:00.000Z",
};

function makeMockDeletionStore() {
  return {
    list: vi.fn().mockResolvedValue({ requests: [mockDeletionRequest], total: 1 }),
    create: vi.fn().mockResolvedValue(mockDeletionRequest),
    cancel: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue(mockDeletionRequest),
    getPendingForTenant: vi.fn().mockResolvedValue(null),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    findExpired: vi.fn().mockResolvedValue([]),
  };
}

function makeMockAuditLog() {
  return {
    query: vi.fn().mockReturnValue({ entries: [], total: 0 }),
    exportCsv: vi.fn().mockReturnValue("csv-data"),
    log: vi.fn(),
  } as unknown as import("@wopr-network/platform-core/admin").AdminAuditLog;
}

function makeDeps(store: ReturnType<typeof makeMockDeletionStore>): AdminRouterDeps {
  return {
    getAuditLog: () => makeMockAuditLog(),
    getCreditLedger: () =>
      ({
        credit: vi.fn(),
        debit: vi.fn(),
        balance: vi.fn(),
        hasReferenceId: vi.fn(),
        history: vi.fn(),
        tenantsWithBalance: vi.fn(),
        expiredCredits: vi.fn(),
        memberUsage: vi.fn(),
      }) as unknown as import("@wopr-network/platform-core/credits").ICreditLedger,
    getUserStore: () =>
      ({
        list: vi.fn(),
        getById: vi.fn(),
      }) as unknown as import("../../../admin/users/user-store.js").AdminUserStore,
    getTenantStatusStore: () =>
      ({
        get: vi.fn(),
        getStatus: vi.fn(),
        suspend: vi.fn(),
        reactivate: vi.fn(),
        ban: vi.fn(),
        list: vi.fn(),
      }) as unknown as import("../../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
    getAccountDeletionStore: () => store as unknown as IAccountDeletionStore,
  };
}

type CallerCtx = Parameters<typeof adminRouter.createCaller>[0];

function adminCtx(): CallerCtx {
  return {
    user: { id: "admin-1", roles: ["platform_admin"] },
    tenantId: undefined,
  };
}

function nonAdminCtx(): CallerCtx {
  return {
    user: { id: "user-1", roles: [] as string[] },
    tenantId: undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin.complianceDeletionRequests", () => {
  const store = makeMockDeletionStore();

  beforeEach(() => {
    vi.clearAllMocks();
    setAdminRouterDeps(makeDeps(store));
  });

  it("lists deletion requests with default pagination", async () => {
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.complianceDeletionRequests({});
    expect(result).toEqual({ requests: [mockDeletionRequest], total: 1 });
    expect(store.list).toHaveBeenCalledWith({ status: undefined, limit: 50, offset: 0 });
  });

  it("passes status filter through", async () => {
    const caller = adminRouter.createCaller(adminCtx());
    await caller.complianceDeletionRequests({ status: "pending", limit: 10, offset: 5 });
    expect(store.list).toHaveBeenCalledWith({ status: "pending", limit: 10, offset: 5 });
  });

  it("rejects non-admin users", async () => {
    const caller = adminRouter.createCaller(nonAdminCtx());
    await expect(caller.complianceDeletionRequests({})).rejects.toThrow("Platform admin role required");
  });
});

describe("admin.complianceTriggerDeletion", () => {
  const store = makeMockDeletionStore();

  beforeEach(() => {
    vi.clearAllMocks();
    setAdminRouterDeps(makeDeps(store));
  });

  it("creates a deletion request", async () => {
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.complianceTriggerDeletion({ tenantId: "t-1", reason: "GDPR request" });
    expect(result).toEqual(mockDeletionRequest);
    expect(store.create).toHaveBeenCalledWith("t-1", "admin-1", "GDPR request");
  });

  it("rejects non-admin users", async () => {
    const caller = adminRouter.createCaller(nonAdminCtx());
    await expect(caller.complianceTriggerDeletion({ tenantId: "t-1", reason: "test" })).rejects.toThrow(
      "Platform admin role required",
    );
  });

  it("throws CONFLICT when a pending deletion already exists for the tenant", async () => {
    (store.getPendingForTenant as ReturnType<typeof vi.fn>).mockResolvedValue(mockDeletionRequest);
    const caller = adminRouter.createCaller(adminCtx());
    await expect(caller.complianceTriggerDeletion({ tenantId: "t-1", reason: "GDPR request" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(store.create).not.toHaveBeenCalled();
  });
});

describe("admin.complianceCancelDeletion", () => {
  const store = makeMockDeletionStore();

  beforeEach(() => {
    vi.clearAllMocks();
    setAdminRouterDeps(makeDeps(store));
  });

  it("cancels a deletion request", async () => {
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.complianceCancelDeletion({ requestId: "del-1" });
    expect(result).toEqual({ success: true });
    expect(store.cancel).toHaveBeenCalledWith("del-1", "Cancelled by admin");
  });

  it("rejects non-admin users", async () => {
    const caller = adminRouter.createCaller(nonAdminCtx());
    await expect(caller.complianceCancelDeletion({ requestId: "del-1" })).rejects.toThrow(
      "Platform admin role required",
    );
  });
});
