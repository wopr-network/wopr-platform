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

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleAdminAuditLogRepository } from "../../admin/admin-audit-log-repository.js";
import { AdminAuditLog } from "../../admin/audit-log.js";
import { AdminUserStore } from "../../admin/users/user-store.js";
import type { DrizzleDb } from "../../db/index.js";
import { Credit } from "../../monetization/credit.js";
import { DrizzleAutoTopupSettingsRepository } from "../../monetization/credits/auto-topup-settings-repository.js";
import { BotBilling } from "../../monetization/credits/bot-billing.js";
import type {
  CreditTransaction,
  CreditType,
  DebitType,
  HistoryOptions,
  ICreditLedger,
} from "../../monetization/credits/credit-ledger.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { appRouter } from "../../trpc/index.js";
import type { TRPCContext } from "../../trpc/init.js";
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

function makeMockLedger(): ICreditLedger {
  const balances = new Map<string, number>();
  return {
    async credit(
      tenantId: string,
      amount: Credit,
      _type: CreditType,
      _description?: string,
      _referenceId?: string,
      _fundingSource?: string,
    ): Promise<CreditTransaction> {
      const cents = amount.toCents();
      balances.set(tenantId, (balances.get(tenantId) ?? 0) + cents);
      return {
        id: "tx-1",
        tenantId,
        amount,
        balanceAfter: Credit.fromCents(balances.get(tenantId) ?? 0),
        type: "signup_grant",
        description: null,
        referenceId: null,
        fundingSource: null,
        attributedUserId: null,
        createdAt: new Date().toISOString(),
      };
    },
    async debit(
      tenantId: string,
      amount: Credit,
      _type: DebitType,
      _description?: string,
      _referenceId?: string,
      _allowNegative?: boolean,
    ): Promise<CreditTransaction> {
      const cents = amount.toCents();
      balances.set(tenantId, (balances.get(tenantId) ?? 0) - cents);
      return {
        id: "tx-2",
        tenantId,
        amount: amount.multiply(-1),
        balanceAfter: Credit.fromCents(balances.get(tenantId) ?? 0),
        type: "correction",
        description: null,
        referenceId: null,
        fundingSource: null,
        attributedUserId: null,
        createdAt: new Date().toISOString(),
      };
    },
    async balance(tenantId: string): Promise<Credit> {
      return Credit.fromCents(balances.get(tenantId) ?? 0);
    },
    async hasReferenceId(_referenceId: string): Promise<boolean> {
      return false;
    },
    async history(_tenantId: string, _opts?: HistoryOptions): Promise<CreditTransaction[]> {
      return [];
    },
    async tenantsWithBalance(): Promise<Array<{ tenantId: string; balance: Credit }>> {
      return [];
    },
    async memberUsage(_tenantId: string) {
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
  let creditLedger: ICreditLedger;
  let botBilling: BotBilling;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    pool = t.pool;
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    statusStore = new TenantStatusStore(db);
    auditLog = new AdminAuditLog(new DrizzleAdminAuditLogRepository(db));
    creditLedger = makeMockLedger();
    botBilling = new BotBilling(db);

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
      await creditLedger.credit("tenant-1", Credit.fromCents(5000), "signup_grant", "initial credit");

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
      await creditLedger.credit("tenant-1", Credit.fromCents(3000), "signup_grant", "initial");

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
