/**
 * Tests for tRPC admin tenant status routes (WOP-412).
 *
 * Covers:
 * - suspendTenant: required reason, role check, state transitions, audit logging
 * - reactivateTenant: role check, state transitions, audit logging
 * - banTenant: typed confirmation, auto-refund, role check, audit logging
 * - tenantStatus: query current status
 */

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminAuditLog } from "../../admin/audit-log.js";
import { CreditAdjustmentStore } from "../../admin/credits/adjustment-store.js";
import { initCreditAdjustmentSchema } from "../../admin/credits/schema.js";
import { initAdminUsersSchema } from "../../admin/users/schema.js";
import { AdminUserStore } from "../../admin/users/user-store.js";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { BotBilling } from "../../monetization/credits/bot-billing.js";
import { InMemoryBotBillingRepository } from "../../infrastructure/persistence/in-memory-bot-billing-repository.js";
import { appRouter } from "../../trpc/index.js";
import type { TRPCContext } from "../../trpc/init.js";
import { setAdminRouterDeps } from "../../trpc/routers/admin.js";
import { TenantStatusStore } from "./tenant-status-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initSchemas(sqlite: BetterSqlite3.Database): void {
  // Admin audit log
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      admin_user TEXT NOT NULL,
      action TEXT NOT NULL,
      category TEXT NOT NULL,
      target_tenant TEXT,
      target_user TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // Credit adjustments
  initCreditAdjustmentSchema(sqlite);

  // Admin users
  initAdminUsersSchema(sqlite);

  // Tenant status
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tenant_status (
      tenant_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      status_reason TEXT,
      status_changed_at INTEGER,
      status_changed_by TEXT,
      grace_deadline TEXT,
      data_delete_after TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Bot instances
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bot_instances (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      node_id TEXT,
      billing_state TEXT NOT NULL DEFAULT 'active',
      suspended_at TEXT,
      destroy_after TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin tenant status tRPC routes", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let statusStore: TenantStatusStore;
  let auditLog: AdminAuditLog;
  let creditStore: CreditAdjustmentStore;
  let botBilling: BotBilling;
  let botBillingRepo: InMemoryBotBillingRepository;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    sqlite.pragma("journal_mode = WAL");
    initSchemas(sqlite);
    db = createDb(sqlite);
    statusStore = new TenantStatusStore(db);
    auditLog = new AdminAuditLog(db);
    creditStore = new CreditAdjustmentStore(sqlite);
    botBillingRepo = new InMemoryBotBillingRepository();
    botBilling = new BotBilling(botBillingRepo);

    setAdminRouterDeps({
      getAuditLog: () => auditLog,
      getCreditStore: () => creditStore,
      getUserStore: () => new AdminUserStore(sqlite),
      getTenantStatusStore: () => statusStore,
      getBotBilling: () => botBilling,
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  // -------------------------------------------------------------------------
  // tenantStatus query
  // -------------------------------------------------------------------------

  describe("tenantStatus", () => {
    it("returns active for unknown tenant", async () => {
      const caller = createCaller(adminContext());
      const result = await caller.admin.tenantStatus({ tenantId: "unknown-tenant" });
      expect(result.status).toBe("active");
    });

    it("returns current status for existing tenant", async () => {
      statusStore.suspend("tenant-1", "test", "admin-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.tenantStatus({ tenantId: "tenant-1" });
      expect(result.status).toBe("suspended");
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
      statusStore.ensureExists("tenant-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.suspendTenant({
        tenantId: "tenant-1",
        reason: "Suspicious activity",
      });

      expect(result.status).toBe("suspended");
      expect(result.reason).toBe("Suspicious activity");
      expect(statusStore.getStatus("tenant-1")).toBe("suspended");
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
      statusStore.suspend("tenant-1", "initial", "admin-1");
      const caller = createCaller(adminContext());
      await expect(caller.admin.suspendTenant({ tenantId: "tenant-1", reason: "again" })).rejects.toThrow(
        "already suspended",
      );
    });

    it("rejects if banned", async () => {
      statusStore.ban("tenant-1", "tos", "admin-1");
      const caller = createCaller(adminContext());
      await expect(caller.admin.suspendTenant({ tenantId: "tenant-1", reason: "suspend" })).rejects.toThrow(
        "Cannot suspend a banned account",
      );
    });

    it("suspends all bots for the tenant", async () => {
      statusStore.ensureExists("tenant-1");
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
      statusStore.ensureExists("tenant-1");
      const caller = createCaller(adminContext());
      await caller.admin.suspendTenant({
        tenantId: "tenant-1",
        reason: "Suspicious activity",
      });

      const entries = auditLog.query({ action: "tenant.suspend" });
      expect(entries.total).toBe(1);
      expect(entries.entries[0].target_tenant).toBe("tenant-1");
      expect(entries.entries[0].admin_user).toBe("admin-1");
    });

    it("can suspend a grace_period tenant", async () => {
      statusStore.setGracePeriod("tenant-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.suspendTenant({
        tenantId: "tenant-1",
        reason: "manual override",
      });

      expect(result.status).toBe("suspended");
      expect(statusStore.getStatus("tenant-1")).toBe("suspended");
    });
  });

  // -------------------------------------------------------------------------
  // reactivateTenant
  // -------------------------------------------------------------------------

  describe("reactivateTenant", () => {
    it("reactivates a suspended tenant", async () => {
      statusStore.suspend("tenant-1", "review", "admin-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.reactivateTenant({ tenantId: "tenant-1" });

      expect(result.status).toBe("active");
      expect(statusStore.getStatus("tenant-1")).toBe("active");
    });

    it("requires platform_admin role", async () => {
      const caller = createCaller(nonAdminContext());
      await expect(caller.admin.reactivateTenant({ tenantId: "tenant-1" })).rejects.toThrow(
        "Platform admin role required",
      );
    });

    it("rejects if already active", async () => {
      statusStore.ensureExists("tenant-1");
      const caller = createCaller(adminContext());
      await expect(caller.admin.reactivateTenant({ tenantId: "tenant-1" })).rejects.toThrow("already active");
    });

    it("rejects if banned", async () => {
      statusStore.ban("tenant-1", "tos", "admin-1");
      const caller = createCaller(adminContext());
      await expect(caller.admin.reactivateTenant({ tenantId: "tenant-1" })).rejects.toThrow(
        "Cannot reactivate a banned account",
      );
    });

    it("can reactivate a grace_period tenant", async () => {
      statusStore.setGracePeriod("tenant-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.reactivateTenant({ tenantId: "tenant-1" });

      expect(result.status).toBe("active");
    });

    it("logs to audit log", async () => {
      statusStore.suspend("tenant-1", "review", "admin-1");
      const caller = createCaller(adminContext());
      await caller.admin.reactivateTenant({ tenantId: "tenant-1" });

      const entries = auditLog.query({ action: "tenant.reactivate" });
      expect(entries.total).toBe(1);
      expect(entries.entries[0].target_tenant).toBe("tenant-1");
    });
  });

  // -------------------------------------------------------------------------
  // banTenant
  // -------------------------------------------------------------------------

  describe("banTenant", () => {
    it("bans a tenant with correct confirmation", async () => {
      statusStore.ensureExists("tenant-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "Spam abuse",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      expect(result.status).toBe("banned");
      expect(result.reason).toBe("Spam abuse");
      expect(statusStore.getStatus("tenant-1")).toBe("banned");
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
      statusStore.ban("tenant-1", "first ban", "admin-1");
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
      statusStore.ensureExists("tenant-1");
      creditStore.grant("tenant-1", 5000, "initial credit", "system");

      const caller = createCaller(adminContext());
      const result = await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "abuse",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      expect(result.refundedCents).toBe(5000);
      expect(creditStore.getBalance("tenant-1")).toBe(0);
    });

    it("does not refund when balance is zero", async () => {
      statusStore.ensureExists("tenant-1");
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
      statusStore.ensureExists("tenant-1");
      botBilling.registerBot("bot-1", "tenant-1", "bot-a");

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
      statusStore.ensureExists("tenant-1");
      creditStore.grant("tenant-1", 3000, "initial", "system");

      const caller = createCaller(adminContext());
      await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "Spam abuse",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      const entries = auditLog.query({ action: "tenant.ban" });
      expect(entries.total).toBe(1);
      expect(entries.entries[0].target_tenant).toBe("tenant-1");
      const details = JSON.parse(entries.entries[0].details);
      expect(details.tosReference).toBe("ToS 5.2");
      expect(details.refundedCents).toBe(3000);
    });

    it("can ban a suspended tenant", async () => {
      statusStore.suspend("tenant-1", "review", "admin-1");
      const caller = createCaller(adminContext());
      const result = await caller.admin.banTenant({
        tenantId: "tenant-1",
        reason: "escalated",
        tosReference: "ToS 5.2",
        confirmName: "BAN tenant-1",
      });

      expect(result.status).toBe("banned");
    });
  });
});
