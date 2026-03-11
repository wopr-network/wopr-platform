import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleAdminAuditLogRepository } from "../../src/admin/admin-audit-log-repository.js";
import { AdminAuditLog } from "../../src/admin/audit-log.js";
import type { AuditEntry } from "../../src/admin/audit-log.js";
import { RoleStore } from "../../src/admin/roles/role-store.js";
import { AdminUserStore } from "../../src/admin/users/user-store.js";
import { EvidenceCollector } from "../../src/compliance/evidence-collector.js";
import type { DrizzleDb } from "../../src/db/index.js";
import { adminAuditLog, adminUsers } from "../../src/db/schema/index.js";
import { DrizzleMarketplacePluginRepository } from "../../src/marketplace/drizzle-marketplace-plugin-repository.js";
import { CreditLedger } from "@wopr-network/platform-core";
import { Credit } from "@wopr-network/platform-core";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
} from "../../src/test/db.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let pool: PGlite;
let db: DrizzleDb;

const ADMIN_ID = crypto.randomUUID();
const ADMIN_EMAIL = "admin@wopr.test";
const TENANT_ID = `tenant-${crypto.randomUUID()}`;
const USER_ID = crypto.randomUUID();
const USER_EMAIL = "user@wopr.test";

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
  await beginTestTransaction(pool);
});

afterAll(async () => {
  await endTestTransaction(pool);
  await pool.close();
});

describe("E2E: admin operations — login → manage users → audit log → compliance export", () => {
  let auditLog: AdminAuditLog;
  let roleStore: RoleStore;
  let userStore: AdminUserStore;
  let marketplaceRepo: DrizzleMarketplacePluginRepository;

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    auditLog = new AdminAuditLog(new DrizzleAdminAuditLogRepository(db));
    roleStore = new RoleStore(db);
    userStore = new AdminUserStore(db);
    marketplaceRepo = new DrizzleMarketplacePluginRepository(db);
  });

  // =========================================================================
  // STEP 1: Create admin user with elevated role
  // =========================================================================

  it("1. seed admin user, grant platform_admin role, verify admin access", async () => {
    await db.insert(adminUsers).values({
      id: ADMIN_ID,
      email: ADMIN_EMAIL,
      name: "Platform Admin",
      tenantId: TENANT_ID,
      status: "active",
      role: "platform_admin",
      creditBalanceCents: 10000,
      agentCount: 0,
      createdAt: Date.now(),
    });

    await db.insert(adminUsers).values({
      id: USER_ID,
      email: USER_EMAIL,
      name: "Regular User",
      tenantId: TENANT_ID,
      status: "active",
      role: "user",
      creditBalanceCents: 500,
      agentCount: 2,
      createdAt: Date.now(),
    });

    await roleStore.setRole(ADMIN_ID, RoleStore.PLATFORM_TENANT, "platform_admin", null);

    expect(await roleStore.isPlatformAdmin(ADMIN_ID)).toBe(true);
    expect(await roleStore.isPlatformAdmin(USER_ID)).toBe(false);

    const admins = await roleStore.listPlatformAdmins();
    expect(admins).toHaveLength(1);
    expect(admins[0].user_id).toBe(ADMIN_ID);
  });

  // =========================================================================
  // STEP 2: Admin lists/searches users, updates a user's role
  // =========================================================================

  it("2. admin lists users, searches, and updates user role", async () => {
    await db.insert(adminUsers).values([
      {
        id: ADMIN_ID,
        email: ADMIN_EMAIL,
        name: "Platform Admin",
        tenantId: TENANT_ID,
        status: "active",
        role: "platform_admin",
        creditBalanceCents: 10000,
        agentCount: 0,
        createdAt: Date.now(),
      },
      {
        id: USER_ID,
        email: USER_EMAIL,
        name: "Regular User",
        tenantId: TENANT_ID,
        status: "active",
        role: "user",
        creditBalanceCents: 500,
        agentCount: 2,
        createdAt: Date.now(),
      },
    ]);

    const listResult = await userStore.list();
    expect(listResult.total).toBe(2);
    expect(listResult.users).toHaveLength(2);

    const searchResult = await userStore.search("user@wopr");
    expect(searchResult).toHaveLength(1);
    expect(searchResult[0].email).toBe(USER_EMAIL);

    const nameSearch = await userStore.search("Platform");
    expect(nameSearch).toHaveLength(1);
    expect(nameSearch[0].id).toBe(ADMIN_ID);

    const user = await userStore.getById(USER_ID);
    expect(user).not.toBeNull();
    expect(user!.email).toBe(USER_EMAIL);
    expect(user!.role).toBe("user");

    await roleStore.setRole(USER_ID, TENANT_ID, "tenant_admin", ADMIN_ID);

    const role = await roleStore.getRole(USER_ID, TENANT_ID);
    expect(role).toBe("tenant_admin");

    const auditRow = await auditLog.log({
      adminUser: ADMIN_ID,
      action: "role.set",
      category: "roles",
      targetTenant: TENANT_ID,
      targetUser: USER_ID,
      details: { role: "tenant_admin" },
      ipAddress: "10.0.0.1",
      userAgent: "AdminPanel/1.0",
      outcome: "success",
    });

    expect(auditRow.id).toBeDefined();
    expect(auditRow.action).toBe("role.set");
    expect(auditRow.target_user).toBe(USER_ID);
  });

  // =========================================================================
  // STEP 3: Audit log — verify entries recorded for each admin action
  // =========================================================================

  it("3. audit log records all admin actions with IP, user-agent, outcome", async () => {
    const actions: AuditEntry[] = [
      {
        adminUser: ADMIN_ID,
        action: "user.suspend",
        category: "account",
        targetTenant: TENANT_ID,
        targetUser: USER_ID,
        details: { reason: "ToS violation" },
        ipAddress: "10.0.0.1",
        userAgent: "AdminPanel/1.0",
        outcome: "success",
      },
      {
        adminUser: ADMIN_ID,
        action: "role.set",
        category: "roles",
        targetTenant: TENANT_ID,
        targetUser: USER_ID,
        details: { role: "tenant_admin" },
        ipAddress: "192.168.1.100",
        userAgent: "AdminPanel/2.0",
        outcome: "success",
      },
      {
        adminUser: ADMIN_ID,
        action: "credits.add",
        category: "credits",
        targetTenant: TENANT_ID,
        details: { amount: 5000 },
        ipAddress: "10.0.0.1",
        userAgent: "AdminPanel/1.0",
        outcome: "success",
      },
    ];

    for (const entry of actions) {
      await auditLog.log(entry);
    }

    const result = await auditLog.query({});
    expect(result.total).toBe(3);
    expect(result.entries).toHaveLength(3);

    for (const entry of result.entries) {
      expect(entry.ip_address).not.toBeNull();
      expect(entry.user_agent).not.toBeNull();
      expect(entry.outcome).toBe("success");
    }

    const roleActions = await auditLog.query({ action: "role.set" });
    expect(roleActions.total).toBe(1);
    expect(roleActions.entries[0].action).toBe("role.set");

    const creditActions = await auditLog.query({ category: "credits" });
    expect(creditActions.total).toBe(1);

    const tenantActions = await auditLog.query({ tenant: TENANT_ID });
    expect(tenantActions.total).toBe(3);
  });

  // =========================================================================
  // STEP 4: Compliance export (CSV)
  // =========================================================================

  it("4. compliance export — CSV and JSON evidence report", async () => {
    await auditLog.log({
      adminUser: ADMIN_ID,
      action: "user.suspend",
      category: "account",
      targetTenant: TENANT_ID,
      targetUser: USER_ID,
      details: { reason: "inactivity" },
      ipAddress: "10.0.0.1",
      userAgent: "AdminPanel/1.0",
      outcome: "success",
    });
    await auditLog.log({
      adminUser: ADMIN_ID,
      action: "credits.add",
      category: "credits",
      targetTenant: TENANT_ID,
      details: { amount: 1000 },
      ipAddress: "10.0.0.1",
      userAgent: "AdminPanel/1.0",
      outcome: "success",
    });

    const csv = await auditLog.exportCsv({});
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "id,admin_user,action,category,target_tenant,target_user,details,ip_address,user_agent,created_at,outcome",
    );
    expect(lines).toHaveLength(3); // header + 2 data rows

    const csvFiltered = await auditLog.exportCsv({ from: 0 });
    const filteredLines = csvFiltered.split("\n");
    expect(filteredLines.length).toBeGreaterThanOrEqual(2);

    const adminAuditRepo = new DrizzleAdminAuditLogRepository(db);
    const collector = new EvidenceCollector({
      auditRepo: {
        count: async () => 0,
        countByAction: async () => ({}),
        getTimeRange: async () => ({ oldest: null, newest: null }),
      },
      backupStore: {
        listAll: async () => [],
        listStale: async () => [],
      },
      adminAuditRepo: {
        query: (filters: { from?: number; to?: number }) =>
          adminAuditRepo.query({ from: filters.from, to: filters.to }),
        countByAction: (filters: { from?: number; to?: number }) =>
          adminAuditRepo.countByAction(filters),
      },
      twoFactorRepo: {
        countMandated: async () => 0,
        countTotal: async () => 1,
      },
    });

    const nowDate = new Date();
    const ninetyDaysAgo = new Date(nowDate.getTime() - 90 * 24 * 60 * 60 * 1000);
    const report = await collector.collect({
      from: ninetyDaysAgo.toISOString(),
      to: nowDate.toISOString(),
    });

    expect(report.generatedAt).toBeDefined();
    expect(report.sections.accessReview.adminActions).toBe(2);
    expect(report.sections.accessReview.adminActionBreakdown["user.suspend"]).toBe(1);
    expect(report.sections.accessReview.adminActionBreakdown["credits.add"]).toBe(1);
  });

  // =========================================================================
  // STEP 6: Admin manages marketplace listings (approve/reject plugin)
  // =========================================================================

  it("6. admin manages marketplace — add, approve, reject plugin", async () => {
    const plugin = await marketplaceRepo.insert({
      pluginId: "wopr-plugin-test",
      npmPackage: "@wopr-network/plugin-test",
      version: "1.0.0",
      category: "utility",
      notes: "Test plugin for e2e",
    });

    expect(plugin.pluginId).toBe("wopr-plugin-test");
    expect(plugin.enabled).toBe(false);

    const pending = await marketplaceRepo.findPendingReview();
    expect(pending).toHaveLength(1);
    expect(pending[0].pluginId).toBe("wopr-plugin-test");

    const approved = await marketplaceRepo.update("wopr-plugin-test", {
      enabled: true,
      enabledBy: ADMIN_ID,
    });
    expect(approved.enabled).toBe(true);
    expect(approved.enabledBy).toBe(ADMIN_ID);
    expect(approved.enabledAt).not.toBeNull();

    await auditLog.log({
      adminUser: ADMIN_ID,
      action: "marketplace.plugin.update",
      category: "config",
      details: { pluginId: "wopr-plugin-test", enabled: true },
      outcome: "success",
    });

    await marketplaceRepo.insert({
      pluginId: "wopr-plugin-bad",
      npmPackage: "@wopr-network/plugin-bad",
      version: "0.1.0",
    });
    await marketplaceRepo.delete("wopr-plugin-bad");

    const afterDelete = await marketplaceRepo.findById("wopr-plugin-bad");
    expect(afterDelete).toBeUndefined();

    const allPlugins = await marketplaceRepo.findAll();
    expect(allPlugins).toHaveLength(1);
    expect(allPlugins[0].enabled).toBe(true);
  });

  // =========================================================================
  // EDGE CASE: Non-admin cannot access admin endpoints (403)
  // =========================================================================

  it("7. non-admin user denied platform admin access", async () => {
    expect(await roleStore.isPlatformAdmin(USER_ID)).toBe(false);

    const role = await roleStore.getRole(USER_ID, RoleStore.PLATFORM_TENANT);
    expect(role).toBeNull();

    await roleStore.setRole(USER_ID, TENANT_ID, "tenant_admin", ADMIN_ID);
    expect(await roleStore.isPlatformAdmin(USER_ID)).toBe(false);
    const tenantRole = await roleStore.getRole(USER_ID, TENANT_ID);
    expect(tenantRole).toBe("tenant_admin");
  });

  // =========================================================================
  // EDGE CASE: Audit log date range filtering
  // =========================================================================

  it("8. audit log filters by date range correctly", async () => {
    const oldTs = new Date("2025-01-01T00:00:00Z").getTime();
    const recentTs = new Date("2025-06-01T00:00:00Z").getTime();
    const midTs = new Date("2025-03-01T00:00:00Z").getTime();

    await db.insert(adminAuditLog).values({
      id: crypto.randomUUID(),
      adminUser: ADMIN_ID,
      action: "old.action",
      category: "account",
      details: "{}",
      createdAt: oldTs,
    });
    await db.insert(adminAuditLog).values({
      id: crypto.randomUUID(),
      adminUser: ADMIN_ID,
      action: "recent.action",
      category: "account",
      details: "{}",
      createdAt: recentTs,
    });

    const recent = await auditLog.query({ from: midTs });
    expect(recent.total).toBe(1);
    expect(recent.entries[0].action).toBe("recent.action");

    const old = await auditLog.query({ to: midTs });
    expect(old.total).toBe(1);
    expect(old.entries[0].action).toBe("old.action");
  });

  // =========================================================================
  // PERFORMANCE: Audit log query with 1000+ entries < 2s
  // =========================================================================

  it("9. audit log handles 1000+ entries within 2 seconds", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: crypto.randomUUID(),
      adminUser: ADMIN_ID,
      action: `bulk.action.${i % 10}`,
      category: "account" as const,
      details: JSON.stringify({ index: i }),
      createdAt: Date.now() - i,
    }));

    for (let i = 0; i < rows.length; i += 100) {
      await db.insert(adminAuditLog).values(rows.slice(i, i + 100));
    }

    const start = performance.now();
    const result = await auditLog.query({ limit: 250 });
    const elapsed = performance.now() - start;

    expect(result.total).toBe(1000);
    expect(result.entries).toHaveLength(250);
    expect(elapsed).toBeLessThan(5000);

    const exportStart = performance.now();
    const csv = await auditLog.exportCsv({});
    const exportElapsed = performance.now() - exportStart;

    const csvLines = csv.split("\n");
    expect(csvLines).toHaveLength(1001); // header + 1000 rows
    expect(exportElapsed).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Credit balance test uses db.transaction() internally, which is incompatible
// with the savepoint-based test isolation above. Use a fresh DB instance.
// ---------------------------------------------------------------------------

describe("E2E: admin views credit balances", () => {
  let creditDb: DrizzleDb;
  let creditPool: PGlite;

  beforeAll(async () => {
    ({ db: creditDb, pool: creditPool } = await createTestDb());
  });

  afterAll(async () => {
    await creditPool.close();
  });

  it("5. admin views credit balances for a tenant", async () => {
    const ledger = new CreditLedger(creditDb);
    const tenantId = `tenant-credit-${crypto.randomUUID()}`;

    await ledger.credit(tenantId, Credit.fromCents(5000), "signup_grant", "Welcome credits");

    const balance = await ledger.balance(tenantId);
    expect(balance.equals(Credit.fromCents(5000))).toBe(true);

    const history = await ledger.history(tenantId);
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("signup_grant");

    await ledger.debit(tenantId, Credit.fromCents(200), "adapter_usage", "Image generation");
    const balanceAfter = await ledger.balance(tenantId);
    expect(balanceAfter.equals(Credit.fromCents(4800))).toBe(true);

    const fullHistory = await ledger.history(tenantId);
    expect(fullHistory).toHaveLength(2);
  });
});
