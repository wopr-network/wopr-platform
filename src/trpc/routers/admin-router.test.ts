/**
 * Unit tests for the tRPC admin router.
 *
 * Uses the caller pattern — no HTTP transport needed, tests run against
 * the router directly via appRouter.createCaller(ctx).
 *
 * All AdminRouterDeps are mocked via setAdminRouterDeps(). No PGlite.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Credit } from "../../monetization/credit.js";
import { appRouter } from "../index.js";
import type { TRPCContext } from "../init.js";
import type { AdminRouterDeps } from "./admin.js";
import { setAdminRouterDeps } from "./admin.js";

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function adminContext(): TRPCContext {
  return { user: { id: "admin-1", roles: ["platform_admin"] }, tenantId: "t-admin" };
}

function memberContext(): TRPCContext {
  return { user: { id: "user-1", roles: ["member"] }, tenantId: "t-1" };
}

function unauthContext(): TRPCContext {
  return { user: undefined, tenantId: undefined };
}

function createCaller(ctx: TRPCContext) {
  return appRouter.createCaller(ctx);
}

// ---------------------------------------------------------------------------
// Mock deps
// ---------------------------------------------------------------------------

const mockAuditLog = {
  query: vi.fn().mockReturnValue({ entries: [], total: 0 }),
  exportCsv: vi.fn().mockReturnValue("csv-data"),
  log: vi.fn(),
};

const mockCreditLedger = {
  balance: vi.fn().mockResolvedValue(Credit.fromCents(5000)),
  credit: vi.fn().mockResolvedValue({
    id: "txn-1",
    tenantId: "t-1",
    amount: 1000,
    type: "signup_grant",
    description: "test",
    createdAt: new Date().toISOString(),
  }),
  debit: vi.fn().mockResolvedValue({
    id: "txn-2",
    tenantId: "t-1",
    amount: -500,
    type: "refund",
    description: "test",
    createdAt: new Date().toISOString(),
  }),
  history: vi.fn().mockResolvedValue([]),
};

const mockUserStore = {
  list: vi.fn().mockReturnValue({ users: [], total: 0 }),
  getById: vi.fn().mockResolvedValue({ id: "user-1", email: "u@test.com", name: "Test User" }),
};

const mockTenantStatusStore = {
  get: vi.fn().mockResolvedValue({ tenantId: "t-1", status: "active" }),
  getStatus: vi.fn().mockResolvedValue("active"),
  suspend: vi.fn().mockResolvedValue(undefined),
  reactivate: vi.fn().mockResolvedValue(undefined),
  ban: vi.fn().mockResolvedValue(undefined),
};

const mockBotBilling = {
  suspendAllForTenant: vi.fn().mockResolvedValue(["bot-1"]),
  listForTenant: vi.fn().mockReturnValue([]),
};

const mockDeps: AdminRouterDeps = {
  getAuditLog: () => mockAuditLog as any,
  getCreditLedger: () => mockCreditLedger as any,
  getUserStore: () => mockUserStore as any,
  getTenantStatusStore: () => mockTenantStatusStore as any,
  getBotBilling: () => mockBotBilling as any,
};

beforeAll(() => {
  setAdminRouterDeps(mockDeps);
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset defaults after clearAllMocks
  mockAuditLog.query.mockReturnValue({ entries: [], total: 0 });
  mockAuditLog.exportCsv.mockReturnValue("csv-data");
  mockCreditLedger.balance.mockResolvedValue(Credit.fromCents(5000));
  mockCreditLedger.credit.mockResolvedValue({ id: "txn-1" });
  mockCreditLedger.debit.mockResolvedValue({ id: "txn-2" });
  mockCreditLedger.history.mockResolvedValue([]);
  mockUserStore.list.mockReturnValue({ users: [], total: 0 });
  mockUserStore.getById.mockResolvedValue({ id: "user-1", email: "u@test.com", name: "Test User" });
  mockTenantStatusStore.get.mockResolvedValue({ tenantId: "t-1", status: "active" });
  mockTenantStatusStore.getStatus.mockResolvedValue("active");
  mockTenantStatusStore.suspend.mockResolvedValue(undefined);
  mockTenantStatusStore.reactivate.mockResolvedValue(undefined);
  mockTenantStatusStore.ban.mockResolvedValue(undefined);
  mockBotBilling.suspendAllForTenant.mockResolvedValue(["bot-1"]);
  mockBotBilling.listForTenant.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Auth guard tests
// ---------------------------------------------------------------------------

describe("admin router auth guards", () => {
  const procedures = [
    {
      name: "auditLog",
      call: (c: ReturnType<typeof createCaller>) => c.admin.auditLog({}),
    },
    {
      name: "creditsBalance",
      call: (c: ReturnType<typeof createCaller>) => c.admin.creditsBalance({ tenantId: "t-1" }),
    },
    {
      name: "usersList",
      call: (c: ReturnType<typeof createCaller>) => c.admin.usersList({}),
    },
    {
      name: "suspendTenant",
      call: (c: ReturnType<typeof createCaller>) => c.admin.suspendTenant({ tenantId: "t-1", reason: "test" }),
    },
  ];

  for (const { name, call } of procedures) {
    it(`${name}: rejects unauthenticated with UNAUTHORIZED`, async () => {
      const caller = createCaller(unauthContext());
      await expect(call(caller)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it(`${name}: rejects non-admin with FORBIDDEN`, async () => {
      const caller = createCaller(memberContext());
      await expect(call(caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }
});

// ---------------------------------------------------------------------------
// admin.auditLog
// ---------------------------------------------------------------------------

describe("admin.auditLog", () => {
  it("returns audit log entries for admin caller", async () => {
    mockAuditLog.query.mockReturnValue({ entries: [{ id: "a-1" }], total: 1 });
    const caller = createCaller(adminContext());
    const result = await caller.admin.auditLog({ action: "credits.grant", limit: 10 });
    expect(result).toEqual({ entries: [{ id: "a-1" }], total: 1 });
    expect(mockAuditLog.query).toHaveBeenCalledWith({ action: "credits.grant", limit: 10 });
  });

  it("passes all filters to audit log store", async () => {
    mockAuditLog.query.mockReturnValue({ entries: [], total: 0 });
    const caller = createCaller(adminContext());
    await caller.admin.auditLog({ admin: "admin-1", category: "credits", tenant: "t-1" });
    expect(mockAuditLog.query).toHaveBeenCalledWith({
      admin: "admin-1",
      category: "credits",
      tenant: "t-1",
    });
  });
});

// ---------------------------------------------------------------------------
// admin.auditLogExport
// ---------------------------------------------------------------------------

describe("admin.auditLogExport", () => {
  it("returns CSV export", async () => {
    mockAuditLog.exportCsv.mockReturnValue("header\nrow1");
    const caller = createCaller(adminContext());
    const result = await caller.admin.auditLogExport({});
    expect(result).toEqual({ csv: "header\nrow1" });
  });
});

// ---------------------------------------------------------------------------
// admin.creditsBalance
// ---------------------------------------------------------------------------

describe("admin.creditsBalance", () => {
  it("returns balance in cents for admin caller", async () => {
    mockCreditLedger.balance.mockResolvedValue(Credit.fromCents(5000));
    const caller = createCaller(adminContext());
    const result = await caller.admin.creditsBalance({ tenantId: "t-1" });
    expect(result).toEqual({ tenant: "t-1", balance_cents: 5000 });
  });

  it("rejects invalid tenantId with special chars", async () => {
    const caller = createCaller(adminContext());
    await expect(caller.admin.creditsBalance({ tenantId: "t-1; DROP TABLE" })).rejects.toThrow();
  });

  it("rejects empty tenantId", async () => {
    const caller = createCaller(adminContext());
    await expect(caller.admin.creditsBalance({ tenantId: "" })).rejects.toThrow();
  });

  it("rejects tenantId with spaces", async () => {
    const caller = createCaller(adminContext());
    await expect(caller.admin.creditsBalance({ tenantId: "has spaces" })).rejects.toThrow();
  });

  it("accepts valid tenantId with alphanumeric, dash, underscore", async () => {
    mockCreditLedger.balance.mockResolvedValue(Credit.fromCents(0));
    const caller = createCaller(adminContext());
    const result = await caller.admin.creditsBalance({ tenantId: "valid-tenant_123" });
    expect(result.tenant).toBe("valid-tenant_123");
  });
});

// ---------------------------------------------------------------------------
// admin.creditsGrant
// ---------------------------------------------------------------------------

describe("admin.creditsGrant", () => {
  it("credits tenant and logs audit entry on success", async () => {
    mockCreditLedger.credit.mockResolvedValue({ id: "txn-1" });
    const caller = createCaller(adminContext());
    const result = await caller.admin.creditsGrant({ tenantId: "t-1", amount_cents: 1000, reason: "promo" });
    expect(result).toEqual({ id: "txn-1" });
    expect(mockCreditLedger.credit).toHaveBeenCalledWith("t-1", expect.any(Credit), "signup_grant", "promo");
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "credits.grant", outcome: "success" }),
    );
  });

  it("logs failure on credit error and rethrows", async () => {
    mockCreditLedger.credit.mockRejectedValue(new Error("insufficient funds"));
    const caller = createCaller(adminContext());
    await expect(caller.admin.creditsGrant({ tenantId: "t-1", amount_cents: 1000, reason: "promo" })).rejects.toThrow(
      "insufficient funds",
    );
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "credits.grant", outcome: "failure" }),
    );
  });

  it("rejects zero amount (must be positive)", async () => {
    const caller = createCaller(adminContext());
    await expect(caller.admin.creditsGrant({ tenantId: "t-1", amount_cents: 0, reason: "promo" })).rejects.toThrow();
  });

  it("rejects negative amount", async () => {
    const caller = createCaller(adminContext());
    await expect(caller.admin.creditsGrant({ tenantId: "t-1", amount_cents: -100, reason: "promo" })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// admin.creditsRefund
// ---------------------------------------------------------------------------

describe("admin.creditsRefund", () => {
  it("debits tenant and logs audit entry on success", async () => {
    mockCreditLedger.debit.mockResolvedValue({ id: "txn-2" });
    const caller = createCaller(adminContext());
    const result = await caller.admin.creditsRefund({ tenantId: "t-1", amount_cents: 500, reason: "overcharge" });
    expect(result).toEqual({ id: "txn-2" });
    expect(mockCreditLedger.debit).toHaveBeenCalledWith("t-1", expect.any(Credit), "refund", "overcharge");
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "credits.refund", outcome: "success" }),
    );
  });

  it("logs failure on debit error and rethrows", async () => {
    mockCreditLedger.debit.mockRejectedValue(new Error("debit failed"));
    const caller = createCaller(adminContext());
    await expect(
      caller.admin.creditsRefund({ tenantId: "t-1", amount_cents: 500, reason: "overcharge" }),
    ).rejects.toThrow("debit failed");
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "credits.refund", outcome: "failure" }),
    );
  });
});

// ---------------------------------------------------------------------------
// admin.creditsCorrection
// ---------------------------------------------------------------------------

describe("admin.creditsCorrection", () => {
  it("positive amount calls credit() with promo type", async () => {
    mockCreditLedger.credit.mockResolvedValue({ id: "txn-3" });
    const caller = createCaller(adminContext());
    await caller.admin.creditsCorrection({ tenantId: "t-1", amount_cents: 100, reason: "fix" });
    expect(mockCreditLedger.credit).toHaveBeenCalledWith("t-1", Credit.fromCents(100), "promo", "fix");
  });

  it("negative amount calls debit() with correction type", async () => {
    mockCreditLedger.debit.mockResolvedValue({ id: "txn-4" });
    const caller = createCaller(adminContext());
    await caller.admin.creditsCorrection({ tenantId: "t-1", amount_cents: -200, reason: "fix" });
    expect(mockCreditLedger.debit).toHaveBeenCalledWith("t-1", Credit.fromCents(200), "correction", "fix");
  });

  it("zero amount calls credit() with 1 cent fallback", async () => {
    mockCreditLedger.credit.mockResolvedValue({ id: "txn-5" });
    const caller = createCaller(adminContext());
    await caller.admin.creditsCorrection({ tenantId: "t-1", amount_cents: 0, reason: "fix" });
    expect(mockCreditLedger.credit).toHaveBeenCalledWith("t-1", Credit.fromCents(1), "promo", "fix");
  });
});

// ---------------------------------------------------------------------------
// admin.creditsTransactions
// ---------------------------------------------------------------------------

describe("admin.creditsTransactions", () => {
  it("returns transaction history for a tenant", async () => {
    mockCreditLedger.history.mockResolvedValue([{ id: "txn-1" }, { id: "txn-2" }]);
    const caller = createCaller(adminContext());
    const result = await caller.admin.creditsTransactions({ tenantId: "t-1" });
    expect(result).toEqual({ entries: [{ id: "txn-1" }, { id: "txn-2" }], total: 2 });
  });

  it("returns empty list when no transactions", async () => {
    mockCreditLedger.history.mockResolvedValue([]);
    const caller = createCaller(adminContext());
    const result = await caller.admin.creditsTransactions({ tenantId: "t-1" });
    expect(result).toEqual({ entries: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// admin.usersList
// ---------------------------------------------------------------------------

describe("admin.usersList", () => {
  it("returns user list for admin caller", async () => {
    mockUserStore.list.mockReturnValue({ users: [{ id: "u-1", name: "Alice" }], total: 1 });
    const caller = createCaller(adminContext());
    const result = await caller.admin.usersList({});
    expect(result).toEqual({ users: [{ id: "u-1", name: "Alice" }], total: 1 });
    expect(mockUserStore.list).toHaveBeenCalledWith({});
  });

  it("passes filters to store", async () => {
    mockUserStore.list.mockReturnValue({ users: [], total: 0 });
    const caller = createCaller(adminContext());
    await caller.admin.usersList({ search: "alice", limit: 10, offset: 0 });
    expect(mockUserStore.list).toHaveBeenCalledWith({ search: "alice", limit: 10, offset: 0 });
  });

  it("rejects invalid status with ZodError", async () => {
    const caller = createCaller(adminContext());
    await expect(caller.admin.usersList({ status: "invalid_status" as any })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// admin.usersGet
// ---------------------------------------------------------------------------

describe("admin.usersGet", () => {
  it("returns user by ID for admin caller", async () => {
    mockUserStore.getById.mockResolvedValue({ id: "u-1", name: "Alice" });
    const caller = createCaller(adminContext());
    const result = await caller.admin.usersGet({ userId: "u-1" });
    expect(result).toEqual({ id: "u-1", name: "Alice" });
  });

  it("throws NOT_FOUND when user does not exist", async () => {
    mockUserStore.getById.mockResolvedValue(null);
    const caller = createCaller(adminContext());
    await expect(caller.admin.usersGet({ userId: "nonexistent" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects empty userId with ZodError", async () => {
    const caller = createCaller(adminContext());
    await expect(caller.admin.usersGet({ userId: "" })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// admin.tenantStatus
// ---------------------------------------------------------------------------

describe("admin.tenantStatus", () => {
  it("returns tenant status for existing tenant", async () => {
    mockTenantStatusStore.get.mockResolvedValue({ tenantId: "t-1", status: "active" });
    const caller = createCaller(adminContext());
    const result = await caller.admin.tenantStatus({ tenantId: "t-1" });
    expect(result).toEqual({ tenantId: "t-1", status: "active" });
  });

  it("returns default active status when no row exists", async () => {
    mockTenantStatusStore.get.mockResolvedValue(null);
    const caller = createCaller(adminContext());
    const result = await caller.admin.tenantStatus({ tenantId: "t-new" });
    expect(result).toEqual({ tenantId: "t-new", status: "active" });
  });
});

// ---------------------------------------------------------------------------
// admin.suspendTenant
// ---------------------------------------------------------------------------

describe("admin.suspendTenant", () => {
  it("suspends an active tenant", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("active");
    mockTenantStatusStore.suspend.mockResolvedValue(undefined);
    mockBotBilling.suspendAllForTenant.mockResolvedValue(["bot-1"]);
    const caller = createCaller(adminContext());
    const result = await caller.admin.suspendTenant({ tenantId: "t-1", reason: "abuse" });
    expect(result).toEqual({
      tenantId: "t-1",
      status: "suspended",
      reason: "abuse",
      suspendedBots: ["bot-1"],
    });
    expect(mockTenantStatusStore.suspend).toHaveBeenCalledWith("t-1", "abuse", "admin-1");
  });

  it("rejects suspending a banned account", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("banned");
    const caller = createCaller(adminContext());
    await expect(caller.admin.suspendTenant({ tenantId: "t-1", reason: "abuse" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Cannot suspend a banned account",
    });
  });

  it("rejects suspending an already suspended account", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("suspended");
    const caller = createCaller(adminContext());
    await expect(caller.admin.suspendTenant({ tenantId: "t-1", reason: "abuse" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Account is already suspended",
    });
  });

  it("logs audit entry for suspension", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("active");
    const caller = createCaller(adminContext());
    await caller.admin.suspendTenant({ tenantId: "t-1", reason: "policy violation" });
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "tenant.suspend", category: "account" }),
    );
  });
});

// ---------------------------------------------------------------------------
// admin.reactivateTenant
// ---------------------------------------------------------------------------

describe("admin.reactivateTenant", () => {
  it("reactivates a suspended tenant", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("suspended");
    mockTenantStatusStore.reactivate.mockResolvedValue(undefined);
    const caller = createCaller(adminContext());
    const result = await caller.admin.reactivateTenant({ tenantId: "t-1" });
    expect(result).toEqual({ tenantId: "t-1", status: "active" });
    expect(mockTenantStatusStore.reactivate).toHaveBeenCalledWith("t-1", "admin-1");
  });

  it("rejects reactivating a banned account", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("banned");
    const caller = createCaller(adminContext());
    await expect(caller.admin.reactivateTenant({ tenantId: "t-1" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Cannot reactivate a banned account",
    });
  });

  it("rejects reactivating an already active account", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("active");
    const caller = createCaller(adminContext());
    await expect(caller.admin.reactivateTenant({ tenantId: "t-1" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Account is already active",
    });
  });
});

// ---------------------------------------------------------------------------
// admin.banTenant
// ---------------------------------------------------------------------------

describe("admin.banTenant", () => {
  it("bans a tenant with correct confirmation string", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("active");
    mockBotBilling.suspendAllForTenant.mockResolvedValue(["bot-1"]);
    mockCreditLedger.balance.mockResolvedValue(Credit.fromCents(1000));
    mockCreditLedger.debit.mockResolvedValue({ id: "refund-1" });
    const caller = createCaller(adminContext());
    const result = await caller.admin.banTenant({
      tenantId: "t-1",
      reason: "TOS violation",
      tosReference: "section-3",
      confirmName: "BAN t-1",
    });
    expect(result.status).toBe("banned");
    expect(result.refundedCents).toBe(1000);
    expect(result.suspendedBots).toEqual(["bot-1"]);
  });

  it("rejects with wrong confirmation string", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("active");
    const caller = createCaller(adminContext());
    await expect(
      caller.admin.banTenant({
        tenantId: "t-1",
        reason: "TOS",
        tosReference: "s3",
        confirmName: "WRONG",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects banning an already banned account", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("banned");
    const caller = createCaller(adminContext());
    await expect(
      caller.admin.banTenant({
        tenantId: "t-1",
        reason: "TOS",
        tosReference: "s3",
        confirmName: "BAN t-1",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Account is already banned" });
  });

  it("skips credit debit when balance is zero", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("active");
    mockBotBilling.suspendAllForTenant.mockResolvedValue([]);
    mockCreditLedger.balance.mockResolvedValue(Credit.ZERO);
    const caller = createCaller(adminContext());
    const result = await caller.admin.banTenant({
      tenantId: "t-1",
      reason: "TOS",
      tosReference: "s3",
      confirmName: "BAN t-1",
    });
    expect(result.refundedCents).toBe(0);
    expect(mockCreditLedger.debit).not.toHaveBeenCalled();
  });

  it("logs audit entry for ban", async () => {
    mockTenantStatusStore.getStatus.mockResolvedValue("active");
    mockCreditLedger.balance.mockResolvedValue(Credit.ZERO);
    const caller = createCaller(adminContext());
    await caller.admin.banTenant({
      tenantId: "t-1",
      reason: "TOS",
      tosReference: "s3",
      confirmName: "BAN t-1",
    });
    expect(mockAuditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "tenant.ban", category: "account" }),
    );
  });
});

// ---------------------------------------------------------------------------
// admin.tenantDetail
// ---------------------------------------------------------------------------

describe("admin.tenantDetail", () => {
  it("aggregates user, credits, and status for a tenant", async () => {
    mockUserStore.getById.mockResolvedValue({ id: "t-1", name: "Tenant Corp" });
    mockCreditLedger.balance.mockResolvedValue(Credit.fromCents(2000));
    mockCreditLedger.history.mockResolvedValue([{ id: "txn-1" }]);
    mockTenantStatusStore.get.mockResolvedValue({ tenantId: "t-1", status: "active" });
    const caller = createCaller(adminContext());
    const result = await caller.admin.tenantDetail({ tenantId: "t-1" });
    expect(result.user).toEqual({ id: "t-1", name: "Tenant Corp" });
    expect(result.credits.balance_cents).toBe(2000);
    expect(result.credits.recent_transactions).toEqual([{ id: "txn-1" }]);
    expect(result.status).toEqual({ tenantId: "t-1", status: "active" });
  });

  it("returns null user and default status when tenant has no records", async () => {
    mockUserStore.getById.mockResolvedValue(null);
    mockCreditLedger.balance.mockResolvedValue(Credit.ZERO);
    mockCreditLedger.history.mockResolvedValue([]);
    mockTenantStatusStore.get.mockResolvedValue(null);
    const caller = createCaller(adminContext());
    const result = await caller.admin.tenantDetail({ tenantId: "t-new" });
    expect(result.user).toBeNull();
    expect(result.credits.balance_cents).toBe(0);
    expect(result.status).toEqual({ tenantId: "t-new", status: "active" });
  });
});

// ---------------------------------------------------------------------------
// admin.tenantAgents
// ---------------------------------------------------------------------------

describe("admin.tenantAgents", () => {
  it("returns bot list for tenant", async () => {
    mockBotBilling.listForTenant.mockReturnValue([{ id: "bot-1" }, { id: "bot-2" }]);
    const caller = createCaller(adminContext());
    const result = await caller.admin.tenantAgents({ tenantId: "t-1" });
    expect(result).toEqual({ agents: [{ id: "bot-1" }, { id: "bot-2" }] });
  });

  it("returns empty agents list when no bots", async () => {
    mockBotBilling.listForTenant.mockReturnValue([]);
    const caller = createCaller(adminContext());
    const result = await caller.admin.tenantAgents({ tenantId: "t-1" });
    expect(result).toEqual({ agents: [] });
  });
});
