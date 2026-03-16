import type { PGlite } from "@electric-sql/pglite";

/**
 * Tests for tRPC admin tenant status routes (WOP-412).
 *
 * Covers:
 * - suspendTenant: required reason, role check, state transitions, audit logging
 * - reactivateTenant: role check, state transitions, audit logging
 * - banTenant: typed confirmation, auto-refund, role check, audit logging
 * - tenantStatus: query current status
 */

import { AdminAuditLog, DrizzleAdminAuditLogRepository } from "@wopr-network/platform-core/admin";
import type { ILedger, JournalEntry } from "@wopr-network/platform-core/credits";
import { Credit, DrizzleAutoTopupSettingsRepository } from "@wopr-network/platform-core/credits";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { DrizzleBotInstanceRepository } from "@wopr-network/platform-core/fleet/drizzle-bot-instance-repository";
import { BotBilling } from "@wopr-network/platform-core/monetization/credits/bot-billing";
import type { IOrgMemberRepository } from "@wopr-network/platform-core/tenancy/org-member-repository";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
} from "@wopr-network/platform-core/test/db";
import type { TRPCContext } from "@wopr-network/platform-core/trpc";
import { setTrpcOrgMemberRepo } from "@wopr-network/platform-core/trpc";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Wire org member repo so isAuthed middleware doesn't throw INTERNAL_SERVER_ERROR
setTrpcOrgMemberRepo({
  findMember: vi.fn().mockResolvedValue({ id: "m1", orgId: "t-1", userId: "user-1", role: "member", joinedAt: 0 }),
  listMembers: vi.fn(),
  addMember: vi.fn(),
  updateMemberRole: vi.fn(),
  removeMember: vi.fn(),
  countAdminsAndOwners: vi.fn(),
  listInvites: vi.fn(),
  createInvite: vi.fn(),
  findInviteById: vi.fn(),
  findInviteByToken: vi.fn(),
  deleteInvite: vi.fn(),
  deleteAllMembers: vi.fn(),
  deleteAllInvites: vi.fn(),
  listOrgsByUser: vi.fn().mockResolvedValue([]),
  markInviteAccepted: vi.fn().mockResolvedValue(undefined),
} as IOrgMemberRepository);

import { AdminUserStore } from "../../admin/users/user-store.js";
import { appRouter } from "../../trpc/index.js";
import { setAdminRouterDeps } from "../../trpc/routers/admin.js";
import { TenantStatusStore } from "./tenant-status-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminContext(): TRPCContext {
  return {
    user: { id: "admin-1", roles: ["platform_admin"] },
    tenantId: "admin-tenant",
  };
}

function nonAdminContext(): TRPCContext {
  return {
    user: { id: "user-1", roles: ["user"] },
    tenantId: "user-tenant",
  };
}

function createCaller(ctx: TRPCContext) {
  return appRouter.createCaller(ctx);
}

function makeMockLedger(): ILedger {
  const balances = new Map<string, number>();
  function makeEntry(tenantId: string, amount: Credit, entryType: string): JournalEntry {
    return {
      id: crypto.randomUUID(),
      postedAt: new Date().toISOString(),
      entryType,
      tenantId,
      description: null,
      referenceId: null,
      metadata: null,
      lines: [{ accountCode: `2000:${tenantId}`, amount, side: "credit" as const }],
    };
  }
  return {
    async post() {
      throw new Error("post() not implemented in mock");
    },
    async credit(tenantId, amount, type, _opts?) {
      const cents = amount.toCents();
      balances.set(tenantId, (balances.get(tenantId) ?? 0) + cents);
      return makeEntry(tenantId, amount, type);
    },
    async debit(tenantId, amount, type, _opts?) {
      const cents = amount.toCents();
      balances.set(tenantId, (balances.get(tenantId) ?? 0) - cents);
      return makeEntry(tenantId, amount, type);
    },
    async balance(tenantId) {
      return Credit.fromCents(balances.get(tenantId) ?? 0);
    },
    async hasReferenceId(_referenceId) {
      return false;
    },
    async history(_tenantId, _opts?) {
      return [];
    },
    async tenantsWithBalance() {
      return [];
    },
    async expiredCredits(_now) {
      return [];
    },
    async memberUsage(_tenantId) {
      return [];
    },
    async lifetimeSpend(_tenantId) {
      return Credit.fromCents(0);
    },
    async lifetimeSpendBatch(tenantIds) {
      return new Map(tenantIds.map((id) => [id, Credit.fromCents(0)]));
    },
    async trialBalance() {
      return { totalDebits: Credit.ZERO, totalCredits: Credit.ZERO, balanced: true, difference: Credit.ZERO };
    },
    async accountBalance(_code) {
      return Credit.ZERO;
    },
    async seedSystemAccounts() {},
    async existsByReferenceIdLike(_pattern) {
      return false;
    },
    async sumPurchasesForPeriod(_start, _end) {
      return Credit.ZERO;
    },
    async getActiveTenantIdsInWindow(_start, _end) {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin tenant status tRPC routes", () => {
  let db: DrizzleDb;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: PGlite;
  let statusStore: TenantStatusStore;
  let auditLog: AdminAuditLog;
  let creditLedger: ILedger;
  let botBilling: BotBilling;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
    await beginTestTransaction(pool);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    statusStore = new TenantStatusStore(db);
    auditLog = new AdminAuditLog(new DrizzleAdminAuditLogRepository(db));
    creditLedger = makeMockLedger();
    botBilling = new BotBilling(new DrizzleBotInstanceRepository(db));

    setAdminRouterDeps({
      getAuditLog: () => auditLog,
      getCreditLedger: () => creditLedger,
      getUserStore: () => new AdminUserStore(db),
      getTenantStatusStore: () => statusStore,
      getBotBilling: () => botBilling,
    });
  });

  // -------------------------------------------------------------------------
  // tenantStatus query
  // -------------------------------------------------------------------------

  describe("tenantStatus", () => {
    it("returns active for unknown tenant", async () => {
      const caller = createCaller(adminContext());
      const result = await caller.admin.tenantStatus({ tenantId: "unknown-tenant" });
      expect(result?.status).toBe("active");
    });

    it("returns current status for existing tenant", async () => {
      await statusStore.suspend("tenant-1", "test", "admin-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.tenantStatus({ tenantId: "tenant-1" });
      expect(result?.status).toBe("suspended");
    });

    it("requires platform_admin role", async () => {
      const caller = createCaller(nonAdminContext());
      await expect(caller.admin.tenantStatus({ tenantId: "tenant-1" })).rejects.toThrow("Platform admin role required");
    });
  });

  // -------------------------------------------------------------------------
  // suspendTenant
  // -------------------------------------------------------------------------

  describe("suspendTenant", () => {
    it("suspends an active tenant", async () => {
      await statusStore.ensureExists("tenant-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.suspendTenant({
        tenantId: "tenant-1",
        reason: "Suspicious activity",
      });

      expect(result?.status).toBe("suspended");
      expect(result.reason).toBe("Suspicious activity");
      expect(await statusStore.getStatus("tenant-1")).toBe("suspended");
    });

    it("requires a reason", async () => {
      const caller = createCaller(adminContext());
      await expect(caller.admin.suspendTenant({ tenantId: "tenant-1", reason: "" })).rejects.toThrow();
    });

    it("requires platform_admin role", async () => {
      const caller = createCaller(nonAdminContext());
      await expect(caller.admin.suspendTenant({ tenantId: "tenant-1", reason: "test" })).rejects.toThrow(
        "Platform admin role required",
      );
    });

    it("rejects if already suspended", async () => {
      await statusStore.suspend("tenant-1", "initial", "admin-1");
      const caller = createCaller(adminContext());
      await expect(caller.admin.suspendTenant({ tenantId: "tenant-1", reason: "again" })).rejects.toThrow(
        "already suspended",
      );
    });

    it("rejects if banned", async () => {
      await statusStore.ban("tenant-1", "tos", "admin-1");
      const caller = createCaller(adminContext());
      await expect(caller.admin.suspendTenant({ tenantId: "tenant-1", reason: "suspend" })).rejects.toThrow(
        "Cannot suspend a banned account",
      );
    });

    it("suspends all bots for the tenant", async () => {
      await statusStore.ensureExists("tenant-1");
      await botBilling.registerBot("bot-1", "tenant-1", "bot-a");
      await botBilling.registerBot("bot-2", "tenant-1", "bot-b");

      const caller = createCaller(adminContext());
      const result = await caller.admin.suspendTenant({
        tenantId: "tenant-1",
        reason: "review",
      });

      expect(result.suspendedBots.sort()).toEqual(["bot-1", "bot-2"]);
      expect(await botBilling.getActiveBotCount("tenant-1")).toBe(0);
    });

    it("logs to audit log", async () => {
      await statusStore.ensureExists("tenant-1");
      const caller = createCaller(adminContext());
      await caller.admin.suspendTenant({
        tenantId: "tenant-1",
        reason: "Suspicious activity",
      });

      const entries = await auditLog.query({ action: "tenant.suspend" });
      expect(entries.total).toBe(1);
      expect(entries.entries[0].target_tenant).toBe("tenant-1");
      expect(entries.entries[0].admin_user).toBe("admin-1");
    });

    it("can suspend a grace_period tenant", async () => {
      await statusStore.setGracePeriod("tenant-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.suspendTenant({
        tenantId: "tenant-1",
        reason: "manual override",
      });

      expect(result?.status).toBe("suspended");
      expect(await statusStore.getStatus("tenant-1")).toBe("suspended");
    });
  });

  // -------------------------------------------------------------------------
  // reactivateTenant
  // -------------------------------------------------------------------------

  describe("reactivateTenant", () => {
    it("reactivates a suspended tenant", async () => {
      await statusStore.suspend("tenant-1", "review", "admin-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.reactivateTenant({ tenantId: "tenant-1" });

      expect(result?.status).toBe("active");
      expect(await statusStore.getStatus("tenant-1")).toBe("active");
    });

    it("requires platform_admin role", async () => {
      const caller = createCaller(nonAdminContext());
      await expect(caller.admin.reactivateTenant({ tenantId: "tenant-1" })).rejects.toThrow(
        "Platform admin role required",
      );
    });

    it("rejects if already active", async () => {
      await statusStore.ensureExists("tenant-1");
      const caller = createCaller(adminContext());
      await expect(caller.admin.reactivateTenant({ tenantId: "tenant-1" })).rejects.toThrow("already active");
    });

    it("rejects if banned", async () => {
      await statusStore.ban("tenant-1", "tos", "admin-1");
      const caller = createCaller(adminContext());
      await expect(caller.admin.reactivateTenant({ tenantId: "tenant-1" })).rejects.toThrow(
        "Cannot reactivate a banned account",
      );
    });

    it("can reactivate a grace_period tenant", async () => {
      await statusStore.setGracePeriod("tenant-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.reactivateTenant({ tenantId: "tenant-1" });

      expect(result?.status).toBe("active");
    });

    it("logs to audit log", async () => {
      await statusStore.suspend("tenant-1", "review", "admin-1");
      const caller = createCaller(adminContext());
      await caller.admin.reactivateTenant({ tenantId: "tenant-1" });

      const entries = await auditLog.query({ action: "tenant.reactivate" });
      expect(entries.total).toBe(1);
      expect(entries.entries[0].target_tenant).toBe("tenant-1");
    });
  });

  // -------------------------------------------------------------------------
  // banTenant
  // -------------------------------------------------------------------------

  describe("banTenant", () => {
    it("bans a tenant with correct confirmation", async () => {
      await statusStore.ensureExists("tenant-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "Spam abuse",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      expect(result?.status).toBe("banned");
      expect(result.reason).toBe("Spam abuse");
      expect(await statusStore.getStatus("tenant-1")).toBe("banned");
    });

    it("requires correct typed confirmation", async () => {
      const caller = createCaller(adminContext());
      await expect(
        caller.admin.banTenant({
          tenantId: "tenant-1",
          reason: "test",
          tosReference: "ToS 5.2",
          confirmName: "wrong confirmation",
        }),
      ).rejects.toThrow('Type "BAN tenant-1" to confirm');
    });

    it("requires platform_admin role", async () => {
      const caller = createCaller(nonAdminContext());
      await expect(
        caller.admin.banTenant({
          tenantId: "tenant-1",
          reason: "test",
          tosReference: "ToS 5.2",
          confirmName: "BAN tenant-1",
        }),
      ).rejects.toThrow("Platform admin role required");
    });

    it("rejects if already banned", async () => {
      await statusStore.ban("tenant-1", "first ban", "admin-1");
      const caller = createCaller(adminContext());
      await expect(
        caller.admin.banTenant({
          tenantId: "tenant-1",
          reason: "again",
          tosReference: "ToS 5.2",
          confirmName: "BAN tenant-1",
        }),
      ).rejects.toThrow("already banned");
    });

    it("auto-refunds remaining credits", async () => {
      await statusStore.ensureExists("tenant-1");
      await creditLedger.credit("tenant-1", Credit.fromCents(5000), "signup_grant", { description: "initial credit" });

      const caller = createCaller(adminContext());
      const result = await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "abuse",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      expect(result.refundedCents).toBe(5000);
      expect((await creditLedger.balance("tenant-1")).isZero()).toBe(true);
    });

    it("does not refund when balance is zero", async () => {
      await statusStore.ensureExists("tenant-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "abuse",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      expect(result.refundedCents).toBe(0);
    });

    it("suspends all bots for the tenant", async () => {
      await statusStore.ensureExists("tenant-1");
      await botBilling.registerBot("bot-1", "tenant-1", "bot-a");

      const caller = createCaller(adminContext());
      const result = await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "abuse",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      expect(result.suspendedBots).toEqual(["bot-1"]);
    });

    it("logs to audit log with details", async () => {
      await statusStore.ensureExists("tenant-1");
      await creditLedger.credit("tenant-1", Credit.fromCents(3000), "signup_grant", { description: "initial" });

      const caller = createCaller(adminContext());
      await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "Spam abuse",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      const entries = await auditLog.query({ action: "tenant.ban" });
      expect(entries.total).toBe(1);
      expect(entries.entries[0].target_tenant).toBe("tenant-1");
      const details = JSON.parse(entries.entries[0].details);
      expect(details.tosReference).toBe("ToS 5.2");
      expect(details.refundedCents).toBe(3000);
    });

    it("disables auto-topup settings on ban", async () => {
      await statusStore.ensureExists("tenant-1");

      // Setup auto-topup settings
      const topupSettingsRepo = new DrizzleAutoTopupSettingsRepository(db);
      await topupSettingsRepo.upsert("tenant-1", {
        usageEnabled: true,
        scheduleEnabled: true,
      });

      setAdminRouterDeps({
        getAuditLog: () => auditLog,
        getCreditLedger: () => creditLedger,
        getUserStore: () => new AdminUserStore(db),
        getTenantStatusStore: () => statusStore,
        getBotBilling: () => botBilling,
        getAutoTopupSettingsRepo: () => topupSettingsRepo,
        detachAllPaymentMethods: async () => 0,
      });

      const caller = createCaller(adminContext());
      await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "abuse",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      const settings = await topupSettingsRepo.getByTenant("tenant-1");
      expect(settings?.usageEnabled).toBe(false);
      expect(settings?.scheduleEnabled).toBe(false);
    });

    it("calls detachAllPaymentMethods on ban", async () => {
      await statusStore.ensureExists("tenant-1");

      const detachFn = vi.fn().mockResolvedValue(2);

      setAdminRouterDeps({
        getAuditLog: () => auditLog,
        getCreditLedger: () => creditLedger,
        getUserStore: () => new AdminUserStore(db),
        getTenantStatusStore: () => statusStore,
        getBotBilling: () => botBilling,
        detachAllPaymentMethods: detachFn,
      });

      const caller = createCaller(adminContext());
      const result = await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "abuse",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      expect(detachFn).toHaveBeenCalledWith("tenant-1");
      expect(result.paymentMethodsDetached).toBe(2);
    });

    it("does NOT disable auto-topup on suspend", async () => {
      await statusStore.ensureExists("tenant-1");

      const topupSettingsRepo = new DrizzleAutoTopupSettingsRepository(db);
      await topupSettingsRepo.upsert("tenant-1", {
        usageEnabled: true,
        scheduleEnabled: true,
      });

      setAdminRouterDeps({
        getAuditLog: () => auditLog,
        getCreditLedger: () => creditLedger,
        getUserStore: () => new AdminUserStore(db),
        getTenantStatusStore: () => statusStore,
        getBotBilling: () => botBilling,
        getAutoTopupSettingsRepo: () => topupSettingsRepo,
      });

      const caller = createCaller(adminContext());
      await caller.admin.suspendTenant({
        tenantId: "tenant-1",
        reason: "review",
      });

      const settings = await topupSettingsRepo.getByTenant("tenant-1");
      expect(settings?.usageEnabled).toBe(true);
      expect(settings?.scheduleEnabled).toBe(true);
    });

    it("can ban a suspended tenant", async () => {
      await statusStore.suspend("tenant-1", "review", "admin-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "escalated",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      expect(result?.status).toBe("banned");
    });
  });
});
