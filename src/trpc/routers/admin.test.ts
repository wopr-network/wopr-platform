import type { ILedger, JournalEntry } from "@wopr-network/platform-core/credits";
import { Credit } from "@wopr-network/platform-core/credits";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AdminRouterDeps } from "./admin.js";
import { adminRouter, setAdminRouterDeps } from "./admin.js";

// ---------------------------------------------------------------------------
// Mock deps factories
// ---------------------------------------------------------------------------

function makeMockAuditLog() {
  return {
    query: vi.fn().mockReturnValue({ entries: [], total: 0 }),
    exportCsv: vi.fn().mockReturnValue("csv-data"),
    log: vi.fn(),
  } as unknown as import("@wopr-network/platform-core/admin").AdminAuditLog;
}

function makeMockLedger(): ILedger {
  return {
    post: vi.fn().mockResolvedValue({} as JournalEntry),
    credit: vi.fn().mockResolvedValue({} as JournalEntry),
    debit: vi.fn().mockResolvedValue({} as JournalEntry),
    debitCapped: vi.fn().mockResolvedValue({} as JournalEntry),
    balance: vi.fn().mockResolvedValue(Credit.ZERO),
    hasReferenceId: vi.fn().mockResolvedValue(false),
    history: vi.fn().mockResolvedValue([]),
    tenantsWithBalance: vi.fn().mockResolvedValue([]),
    expiredCredits: vi.fn().mockResolvedValue([]),
    memberUsage: vi.fn().mockResolvedValue([]),
    lifetimeSpend: vi.fn().mockResolvedValue(Credit.ZERO),
    lifetimeSpendBatch: vi.fn().mockResolvedValue(new Map()),
    trialBalance: vi.fn().mockResolvedValue({
      totalDebits: Credit.ZERO,
      totalCredits: Credit.ZERO,
      balanced: true,
      difference: Credit.ZERO,
    }),
    accountBalance: vi.fn().mockResolvedValue(Credit.ZERO),
    seedSystemAccounts: vi.fn().mockResolvedValue(undefined),
    existsByReferenceIdLike: vi.fn().mockResolvedValue(false),
    sumPurchasesForPeriod: vi.fn().mockResolvedValue(Credit.ZERO),
    getActiveTenantIdsInWindow: vi.fn().mockResolvedValue([]),
  };
}

function makeMockUserStore() {
  return {
    list: vi.fn().mockResolvedValue({ users: [], total: 0 }),
    getById: vi.fn().mockResolvedValue({ id: "u1", email: "test@example.com", roles: [] }),
  };
}

function makeMockTenantStatusStore() {
  return {
    get: vi.fn().mockResolvedValue({ tenantId: "t1", status: "active" }),
    getStatus: vi.fn().mockResolvedValue("active"),
    suspend: vi.fn().mockResolvedValue(undefined),
    reactivate: vi.fn().mockResolvedValue(undefined),
    ban: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };
}

function makeDeps(): AdminRouterDeps {
  return {
    getAuditLog: () => makeMockAuditLog(),
    getCreditLedger: () => makeMockLedger(),
    getUserStore: () => makeMockUserStore() as unknown as import("../../admin/users/user-store.js").AdminUserStore,
    getTenantStatusStore: () =>
      makeMockTenantStatusStore() as unknown as import("../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
  };
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

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

function unauthCtx(): CallerCtx {
  return {
    user: undefined,
    tenantId: undefined,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockDeps: ReturnType<typeof makeDeps>;

beforeAll(() => {
  mockDeps = makeDeps();
  setAdminRouterDeps(mockDeps);
});

// ---------------------------------------------------------------------------
// Auth gate: unauthenticated
// ---------------------------------------------------------------------------

describe("admin router auth gate — unauthenticated", () => {
  it("rejects unauthenticated user from auditLog", async () => {
    const caller = adminRouter.createCaller(unauthCtx());
    await expect(caller.auditLog({})).rejects.toThrow();
    await expect(caller.auditLog({})).rejects.toMatchObject({ message: "Authentication required" });
  });

  it("rejects unauthenticated user from creditsBalance", async () => {
    const caller = adminRouter.createCaller(unauthCtx());
    await expect(caller.creditsBalance({ tenantId: "t1" })).rejects.toMatchObject({
      message: "Authentication required",
    });
  });
});

// ---------------------------------------------------------------------------
// Auth gate: non-admin (5+ procedures as required by acceptance criteria)
// ---------------------------------------------------------------------------

describe("admin router auth gate — non-admin rejected", () => {
  const procedures: Array<{
    name: string;
    call: (c: ReturnType<typeof adminRouter.createCaller>) => Promise<unknown>;
  }> = [
    { name: "auditLog", call: (c) => c.auditLog({}) },
    { name: "creditsBalance", call: (c) => c.creditsBalance({ tenantId: "t1" }) },
    { name: "creditsGrant", call: (c) => c.creditsGrant({ tenantId: "t1", amount_cents: 100, reason: "test" }) },
    { name: "usersList", call: (c) => c.usersList({}) },
    { name: "tenantStatus", call: (c) => c.tenantStatus({ tenantId: "t1" }) },
    { name: "suspendTenant", call: (c) => c.suspendTenant({ tenantId: "t1", reason: "test" }) },
  ];

  for (const { name, call } of procedures) {
    it(`rejects non-admin from ${name}`, async () => {
      const caller = adminRouter.createCaller(nonAdminCtx());
      await expect(call(caller)).rejects.toMatchObject({ message: "Platform admin role required" });
    });
  }
});

// ---------------------------------------------------------------------------
// Admin happy paths: queries
// ---------------------------------------------------------------------------

describe("admin router — admin query happy paths", () => {
  it("auditLog returns entries", async () => {
    const auditLog = makeMockAuditLog();
    setAdminRouterDeps({ ...mockDeps, getAuditLog: () => auditLog });
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.auditLog({});
    expect(result).toEqual({ entries: [], total: 0 });
  });

  it("auditLogExport returns csv", async () => {
    const auditLog = makeMockAuditLog();
    setAdminRouterDeps({ ...mockDeps, getAuditLog: () => auditLog });
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.auditLogExport({});
    expect(result).toEqual({ csv: "csv-data" });
  });

  it("creditsBalance returns balance for tenant", async () => {
    const ledger = makeMockLedger();
    setAdminRouterDeps({ ...mockDeps, getCreditLedger: () => ledger });
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.creditsBalance({ tenantId: "t1" });
    expect(result).toHaveProperty("tenant", "t1");
    expect(result).toHaveProperty("balance_credits");
  });

  it("usersList returns users", async () => {
    const userStore = makeMockUserStore();
    setAdminRouterDeps({
      ...mockDeps,
      getUserStore: () => userStore as unknown as import("../../admin/users/user-store.js").AdminUserStore,
    });
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.usersList({});
    expect(result).toEqual({ users: [], total: 0 });
  });

  it("usersGet returns a user", async () => {
    const userStore = makeMockUserStore();
    setAdminRouterDeps({
      ...mockDeps,
      getUserStore: () => userStore as unknown as import("../../admin/users/user-store.js").AdminUserStore,
    });
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.usersGet({ userId: "u1" });
    expect(result).toHaveProperty("id", "u1");
  });

  it("tenantStatus returns status", async () => {
    const tenantStore = makeMockTenantStatusStore();
    setAdminRouterDeps({
      ...mockDeps,
      getTenantStatusStore: () =>
        tenantStore as unknown as import("../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
    });
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.tenantStatus({ tenantId: "t1" });
    expect(result).toHaveProperty("tenantId", "t1");
  });

  it("creditsTransactions returns entries", async () => {
    const ledger = makeMockLedger();
    setAdminRouterDeps({ ...mockDeps, getCreditLedger: () => ledger });
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.creditsTransactions({ tenantId: "t1" });
    expect(result).toHaveProperty("entries");
    expect(result).toHaveProperty("total");
  });
});

// ---------------------------------------------------------------------------
// Admin happy paths: mutations
// ---------------------------------------------------------------------------

describe("admin router — admin mutation happy paths", () => {
  it("creditsGrant grants credits and logs audit", async () => {
    const auditLog = makeMockAuditLog();
    const ledger = makeMockLedger();
    setAdminRouterDeps({
      ...mockDeps,
      getAuditLog: () => auditLog,
      getCreditLedger: () => ledger,
    });
    const caller = adminRouter.createCaller(adminCtx());
    await caller.creditsGrant({ tenantId: "t1", amount_cents: 500, reason: "bonus" });
    expect(ledger.credit).toHaveBeenCalledOnce();
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "credits.grant", targetTenant: "t1", outcome: "success" }),
    );
  });

  it("creditsRefund debits credits and logs audit", async () => {
    const auditLog = makeMockAuditLog();
    const ledger = makeMockLedger();
    setAdminRouterDeps({
      ...mockDeps,
      getAuditLog: () => auditLog,
      getCreditLedger: () => ledger,
    });
    const caller = adminRouter.createCaller(adminCtx());
    await caller.creditsRefund({ tenantId: "t1", amount_cents: 200, reason: "refund" });
    expect(ledger.debit).toHaveBeenCalledOnce();
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "credits.refund", outcome: "success" }),
    );
  });

  it("creditsCorrection positive amount credits", async () => {
    const ledger = makeMockLedger();
    setAdminRouterDeps({ ...mockDeps, getCreditLedger: () => ledger });
    const caller = adminRouter.createCaller(adminCtx());
    await caller.creditsCorrection({ tenantId: "t1", amount_cents: 100, reason: "fix" });
    expect(ledger.credit).toHaveBeenCalledOnce();
  });

  it("creditsCorrection negative amount debits", async () => {
    const ledger = makeMockLedger();
    setAdminRouterDeps({ ...mockDeps, getCreditLedger: () => ledger });
    const caller = adminRouter.createCaller(adminCtx());
    await caller.creditsCorrection({ tenantId: "t1", amount_cents: -50, reason: "fix" });
    expect(ledger.debit).toHaveBeenCalledOnce();
  });

  it("suspendTenant suspends active tenant", async () => {
    const tenantStore = makeMockTenantStatusStore();
    const auditLog = makeMockAuditLog();
    setAdminRouterDeps({
      ...mockDeps,
      getTenantStatusStore: () =>
        tenantStore as unknown as import("../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
      getAuditLog: () => auditLog,
    });
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.suspendTenant({ tenantId: "t1", reason: "violation" });
    expect(result.status).toBe("suspended");
    expect(tenantStore.suspend).toHaveBeenCalledWith("t1", "violation", "admin-1");
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: "tenant.suspend" }));
  });

  it("reactivateTenant reactivates suspended tenant", async () => {
    const tenantStore = makeMockTenantStatusStore();
    tenantStore.getStatus.mockResolvedValue("suspended");
    const auditLog = makeMockAuditLog();
    setAdminRouterDeps({
      ...mockDeps,
      getTenantStatusStore: () =>
        tenantStore as unknown as import("../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
      getAuditLog: () => auditLog,
    });
    const caller = adminRouter.createCaller(adminCtx());
    const result = await caller.reactivateTenant({ tenantId: "t1" });
    expect(result.status).toBe("active");
    expect(tenantStore.reactivate).toHaveBeenCalledWith("t1", "admin-1");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("admin router — edge cases", () => {
  it("suspendTenant rejects already-suspended tenant", async () => {
    const tenantStore = makeMockTenantStatusStore();
    tenantStore.getStatus.mockResolvedValue("suspended");
    setAdminRouterDeps({
      ...mockDeps,
      getTenantStatusStore: () =>
        tenantStore as unknown as import("../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
    });
    const caller = adminRouter.createCaller(adminCtx());
    await expect(caller.suspendTenant({ tenantId: "t1", reason: "test" })).rejects.toMatchObject({
      message: "Account is already suspended",
    });
  });

  it("reactivateTenant rejects already-active tenant", async () => {
    const tenantStore = makeMockTenantStatusStore();
    tenantStore.getStatus.mockResolvedValue("active");
    setAdminRouterDeps({
      ...mockDeps,
      getTenantStatusStore: () =>
        tenantStore as unknown as import("../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
    });
    const caller = adminRouter.createCaller(adminCtx());
    await expect(caller.reactivateTenant({ tenantId: "t1" })).rejects.toMatchObject({
      message: "Account is already active",
    });
  });

  it("banTenant rejects wrong confirmation string", async () => {
    setAdminRouterDeps(mockDeps);
    const caller = adminRouter.createCaller(adminCtx());
    await expect(
      caller.banTenant({ tenantId: "t1", reason: "fraud", tosReference: "tos-1", confirmName: "WRONG" }),
    ).rejects.toMatchObject({ message: 'Type "BAN t1" to confirm the ban' });
  });

  it("usersGet throws NOT_FOUND for missing user", async () => {
    const userStore = makeMockUserStore();
    userStore.getById.mockResolvedValue(null);
    setAdminRouterDeps({
      ...mockDeps,
      getUserStore: () => userStore as unknown as import("../../admin/users/user-store.js").AdminUserStore,
    });
    const caller = adminRouter.createCaller(adminCtx());
    await expect(caller.usersGet({ userId: "nonexistent" })).rejects.toMatchObject({ message: "User not found" });
  });

  it("creditsGrant logs failure on ledger error", async () => {
    const auditLog = makeMockAuditLog();
    const ledger = makeMockLedger();
    (ledger.credit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB error"));
    setAdminRouterDeps({
      ...mockDeps,
      getAuditLog: () => auditLog,
      getCreditLedger: () => ledger,
    });
    const caller = adminRouter.createCaller(adminCtx());
    await expect(caller.creditsGrant({ tenantId: "t1", amount_cents: 100, reason: "test" })).rejects.toThrow(
      "DB error",
    );
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: "credits.grant", outcome: "failure" }));
  });
});

// ---------------------------------------------------------------------------
// Email notifications via notifyByEmail
// ---------------------------------------------------------------------------

describe("admin router — email notifications", () => {
  function makeMockBulkStore(email: string) {
    return {
      dryRun: vi.fn().mockResolvedValue([{ tenantId: "t1", name: "Test", email, status: "active" }]),
    };
  }

  it("suspendTenant sends email when notifyByEmail is true", async () => {
    const tenantStore = makeMockTenantStatusStore();
    const auditLog = makeMockAuditLog();
    const notificationService = { notifyAdminSuspended: vi.fn(), notifyAdminReactivated: vi.fn() };
    const bulkStore = makeMockBulkStore("test@example.com");
    setAdminRouterDeps({
      ...mockDeps,
      getTenantStatusStore: () =>
        tenantStore as unknown as import("../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
      getAuditLog: () => auditLog,
      getNotificationService: () =>
        notificationService as unknown as import("@wopr-network/platform-core/email").NotificationService,
      getBulkStore: () =>
        bulkStore as unknown as import("../../admin/bulk/bulk-operations-store.js").IBulkOperationsStore,
    });
    const caller = adminRouter.createCaller(adminCtx());
    await caller.suspendTenant({ tenantId: "t1", reason: "violation", notifyByEmail: true });
    expect(notificationService.notifyAdminSuspended).toHaveBeenCalledWith("t1", "test@example.com", "violation");
  });

  it("suspendTenant does NOT send email when notifyByEmail is false", async () => {
    const tenantStore = makeMockTenantStatusStore();
    const auditLog = makeMockAuditLog();
    const notificationService = { notifyAdminSuspended: vi.fn(), notifyAdminReactivated: vi.fn() };
    const bulkStore = makeMockBulkStore("test@example.com");
    setAdminRouterDeps({
      ...mockDeps,
      getTenantStatusStore: () =>
        tenantStore as unknown as import("../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
      getAuditLog: () => auditLog,
      getNotificationService: () =>
        notificationService as unknown as import("@wopr-network/platform-core/email").NotificationService,
      getBulkStore: () =>
        bulkStore as unknown as import("../../admin/bulk/bulk-operations-store.js").IBulkOperationsStore,
    });
    const caller = adminRouter.createCaller(adminCtx());
    await caller.suspendTenant({ tenantId: "t1", reason: "violation", notifyByEmail: false });
    expect(notificationService.notifyAdminSuspended).not.toHaveBeenCalled();
  });

  it("reactivateTenant sends email when notifyByEmail is true", async () => {
    const tenantStore = makeMockTenantStatusStore();
    tenantStore.getStatus.mockResolvedValue("suspended");
    const auditLog = makeMockAuditLog();
    const notificationService = { notifyAdminSuspended: vi.fn(), notifyAdminReactivated: vi.fn() };
    const bulkStore = makeMockBulkStore("test@example.com");
    setAdminRouterDeps({
      ...mockDeps,
      getTenantStatusStore: () =>
        tenantStore as unknown as import("../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
      getAuditLog: () => auditLog,
      getNotificationService: () =>
        notificationService as unknown as import("@wopr-network/platform-core/email").NotificationService,
      getBulkStore: () =>
        bulkStore as unknown as import("../../admin/bulk/bulk-operations-store.js").IBulkOperationsStore,
    });
    const caller = adminRouter.createCaller(adminCtx());
    await caller.reactivateTenant({ tenantId: "t1", notifyByEmail: true });
    expect(notificationService.notifyAdminReactivated).toHaveBeenCalledWith("t1", "test@example.com");
  });

  it("reactivateTenant does NOT send email when notifyByEmail is false", async () => {
    const tenantStore = makeMockTenantStatusStore();
    tenantStore.getStatus.mockResolvedValue("suspended");
    const auditLog = makeMockAuditLog();
    const notificationService = { notifyAdminSuspended: vi.fn(), notifyAdminReactivated: vi.fn() };
    const bulkStore = makeMockBulkStore("test@example.com");
    setAdminRouterDeps({
      ...mockDeps,
      getTenantStatusStore: () =>
        tenantStore as unknown as import("../../admin/tenant-status/tenant-status-repository.js").ITenantStatusRepository,
      getAuditLog: () => auditLog,
      getNotificationService: () =>
        notificationService as unknown as import("@wopr-network/platform-core/email").NotificationService,
      getBulkStore: () =>
        bulkStore as unknown as import("../../admin/bulk/bulk-operations-store.js").IBulkOperationsStore,
    });
    const caller = adminRouter.createCaller(adminCtx());
    await caller.reactivateTenant({ tenantId: "t1", notifyByEmail: false });
    expect(notificationService.notifyAdminReactivated).not.toHaveBeenCalled();
  });
});
