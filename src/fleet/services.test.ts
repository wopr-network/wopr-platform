import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import {
  _resetForTest,
  _setDbForTest,
  getAdminAuditLog,
  getAdminNotesRepo,
  getAdminNotifier,
  getAffiliateFraudRepo,
  getAffiliateRepo,
  getAuditDb,
  getAutoTopupEventLogRepo,
  getAutoTopupSettingsRepo,
  getBackupStatusStore,
  getBotBilling,
  getBotInstanceRepo,
  getBotProfileRepo,
  getBudgetChecker,
  getBulkOpsRepo,
  getCircuitBreakerRepo,
  getCommandBus,
  getConnectionRegistry,
  getCouponRepository,
  getCredentialRepo,
  getCreditLedger,
  getCreditTransactionRepo,
  getDb,
  getDividendRepo,
  getDOClient,
  getEvidenceCollector,
  getFleetEventRepo,
  getGpuNodeRepo,
  getGpuNodeRepository,
  getHeartbeatProcessor,
  getMarketplaceContentRepo,
  getMarketplacePluginRepo,
  getMeterAggregator,
  getMeterEmitter,
  getNodeProvisioner,
  getNodeRegistrar,
  getNodeRepo,
  getNodeRepository,
  getNotificationPrefsStore,
  getNotificationQueueStore,
  getOnboardingScriptRepo,
  getOnboardingSessionRepo,
  getOrgMemberRepo,
  getOrgMembershipRepo,
  getOrgRepo,
  getOrgService,
  getOrphanCleaner,
  getPayRamChargeRepository,
  getPhoneNumberRepo,
  getPluginConfigRepo,
  getPromotionEngine,
  getPromotionRepository,
  getRateLimitRepo,
  getRateOverrideCache,
  getRateOverrideRepository,
  getRecoveryOrchestrator,
  getRecoveryRepo,
  getRedemptionRepository,
  getRegistrationTokenStore,
  getRestoreLogStore,
  getSessionUsageRepo,
  getSetupService,
  getSetupSessionRepo,
  getSpendingCapStore,
  getSystemResourceMonitor,
  getTenantCustomerRepository,
  getTenantStatusRepo,
  getUserRoleRepo,
  getVpsRepo,
} from "./services.js";

describe("services.ts singleton wiring", () => {
  let db: DrizzleDb;
  let pool: PGlite;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    pool = testDb.pool;
    _setDbForTest(db);
  });

  afterAll(async () => {
    _resetForTest();
    await pool.close();
  });

  // -----------------------------------------------------------------------
  // Pure DB repositories — only need getDb()
  // -----------------------------------------------------------------------

  it("instantiates all pure-DB repository singletons", () => {
    const getters: Array<{ name: string; get: () => unknown }> = [
      { name: "registrationTokenStore", get: getRegistrationTokenStore },
      { name: "nodeRepo", get: getNodeRepo },
      { name: "botInstanceRepo", get: getBotInstanceRepo },
      { name: "botProfileRepo", get: getBotProfileRepo },
      { name: "recoveryRepo", get: getRecoveryRepo },
      { name: "spendingCapStore", get: getSpendingCapStore },
      { name: "gpuNodeRepo", get: getGpuNodeRepo },
      { name: "adminNotesRepo", get: getAdminNotesRepo },
      { name: "tenantStatusRepo", get: getTenantStatusRepo },
      { name: "bulkOpsRepo", get: getBulkOpsRepo },
      { name: "notificationQueueStore", get: getNotificationQueueStore },
      { name: "notificationPrefsStore", get: getNotificationPrefsStore },
      { name: "fleetEventRepo", get: getFleetEventRepo },
      { name: "rateLimitRepo", get: getRateLimitRepo },
      { name: "circuitBreakerRepo", get: getCircuitBreakerRepo },
      { name: "creditLedger", get: getCreditLedger },
      { name: "creditTransactionRepo", get: getCreditTransactionRepo },
      { name: "botBilling", get: getBotBilling },
      { name: "meterEmitter", get: getMeterEmitter },
      { name: "meterAggregator", get: getMeterAggregator },
      { name: "budgetChecker", get: getBudgetChecker },
      { name: "tenantCustomerStore", get: getTenantCustomerRepository },
      { name: "payRamChargeStore", get: getPayRamChargeRepository },
      { name: "dividendRepo", get: getDividendRepo },
      { name: "autoTopupSettingsRepo", get: getAutoTopupSettingsRepo },
      { name: "autoTopupEventLogRepo", get: getAutoTopupEventLogRepo },
      { name: "phoneNumberRepo", get: getPhoneNumberRepo },
      { name: "affiliateRepo", get: getAffiliateRepo },
      { name: "affiliateFraudRepo", get: getAffiliateFraudRepo },
      { name: "vpsRepo", get: getVpsRepo },
      { name: "credentialRepo", get: getCredentialRepo },
      { name: "orgRepo", get: getOrgRepo },
      { name: "orgMemberRepo", get: getOrgMemberRepo },
      { name: "orgMembershipRepo", get: getOrgMembershipRepo },
      { name: "marketplacePluginRepo", get: getMarketplacePluginRepo },
      { name: "marketplaceContentRepo", get: getMarketplaceContentRepo },
      { name: "userRoleRepo", get: getUserRoleRepo },
      { name: "onboardingSessionRepo", get: getOnboardingSessionRepo },
      { name: "onboardingScriptRepo", get: getOnboardingScriptRepo },
      { name: "sessionUsageRepo", get: getSessionUsageRepo },
      { name: "setupSessionRepo", get: getSetupSessionRepo },
      { name: "pluginConfigRepo", get: getPluginConfigRepo },
      { name: "promotionRepo", get: getPromotionRepository },
      { name: "couponRepo", get: getCouponRepository },
      { name: "redemptionRepo", get: getRedemptionRepository },
      { name: "rateOverrideRepo", get: getRateOverrideRepository },
    ];

    for (const { name, get } of getters) {
      const instance = get();
      expect(instance, `${name} returned null/undefined`).toBeDefined();
      expect(instance, `${name} returned null`).not.toBeNull();
    }
  });

  // -----------------------------------------------------------------------
  // Composed services — depend on other singletons
  // -----------------------------------------------------------------------

  it("instantiates composed service singletons", () => {
    const getters: Array<{ name: string; get: () => unknown }> = [
      { name: "adminNotifier", get: getAdminNotifier },
      { name: "connectionRegistry", get: getConnectionRegistry },
      { name: "commandBus", get: getCommandBus },
      { name: "heartbeatProcessor", get: getHeartbeatProcessor },
      { name: "orphanCleaner", get: getOrphanCleaner },
      { name: "nodeRegistrar", get: getNodeRegistrar },
      { name: "recoveryOrchestrator", get: getRecoveryOrchestrator },
      { name: "adminAuditLog", get: getAdminAuditLog },
      { name: "restoreLogStore", get: getRestoreLogStore },
      { name: "backupStatusStore", get: getBackupStatusStore },
      { name: "evidenceCollector", get: getEvidenceCollector },
      { name: "orgService", get: getOrgService },
      { name: "rateOverrideCache", get: getRateOverrideCache },
      { name: "promotionEngine", get: getPromotionEngine },
      { name: "systemResourceMonitor", get: getSystemResourceMonitor },
      { name: "setupService", get: getSetupService },
    ];

    for (const { name, get } of getters) {
      const instance = get();
      expect(instance, `${name} returned null/undefined`).toBeDefined();
      expect(instance, `${name} returned null`).not.toBeNull();
    }
  });

  // -----------------------------------------------------------------------
  // Alias getters — must return the same singleton
  // -----------------------------------------------------------------------

  it("alias getters return the same singleton as their primary", () => {
    expect(getNodeRepository()).toBe(getNodeRepo());
    expect(getGpuNodeRepository()).toBe(getGpuNodeRepo());
    expect(getAuditDb()).toBe(getDb());
  });

  // -----------------------------------------------------------------------
  // Singleton identity — same instance on repeated calls
  // -----------------------------------------------------------------------

  it("returns the same instance on repeated calls (singleton identity)", () => {
    expect(getNodeRepo()).toBe(getNodeRepo());
    expect(getCreditLedger()).toBe(getCreditLedger());
    expect(getCommandBus()).toBe(getCommandBus());
    expect(getPromotionEngine()).toBe(getPromotionEngine());
  });

  // -----------------------------------------------------------------------
  // Singletons requiring external env vars
  // -----------------------------------------------------------------------

  it("getDOClient throws without DO_API_TOKEN", () => {
    const orig = process.env.DO_API_TOKEN;
    delete process.env.DO_API_TOKEN;
    try {
      _resetForTest();
      _setDbForTest(db);
      expect(() => getDOClient()).toThrow();
    } finally {
      if (orig !== undefined) process.env.DO_API_TOKEN = orig;
      _resetForTest();
      _setDbForTest(db);
    }
  });

  it("getNodeProvisioner throws without DO_SSH_KEY_ID", () => {
    const origToken = process.env.DO_API_TOKEN;
    const origKey = process.env.DO_SSH_KEY_ID;
    process.env.DO_API_TOKEN = "test-token";
    delete process.env.DO_SSH_KEY_ID;
    try {
      _resetForTest();
      _setDbForTest(db);
      expect(() => getNodeProvisioner()).toThrow();
    } finally {
      if (origToken !== undefined) process.env.DO_API_TOKEN = origToken;
      else delete process.env.DO_API_TOKEN;
      if (origKey !== undefined) process.env.DO_SSH_KEY_ID = origKey;
      _resetForTest();
      _setDbForTest(db);
    }
  });
});
