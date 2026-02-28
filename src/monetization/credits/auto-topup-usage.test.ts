import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb, truncateAllTables } from "../../test/db.js";
import { Credit } from "../credit.js";
import { DrizzleAutoTopupSettingsRepository } from "./auto-topup-settings-repository.js";
import { maybeTriggerUsageTopup, type UsageTopupDeps } from "./auto-topup-usage.js";
import { CreditLedger } from "./credit-ledger.js";

describe("maybeTriggerUsageTopup", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let ledger: CreditLedger;
  let settingsRepo: DrizzleAutoTopupSettingsRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    ledger = new CreditLedger(db);
    settingsRepo = new DrizzleAutoTopupSettingsRepository(db);
  });

  it("does nothing when tenant has no auto-topup settings", async () => {
    const mockCharge = vi.fn();
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it("does nothing when usage_enabled is false", async () => {
    await settingsRepo.upsert("t1", { usageEnabled: false });
    await ledger.credit("t1", Credit.fromCents(50), "purchase", "buy", "ref-1", "stripe");
    const mockCharge = vi.fn();
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it("does nothing when balance is above threshold", async () => {
    await settingsRepo.upsert("t1", {
      usageEnabled: true,
      usageThreshold: Credit.fromCents(100),
      usageTopup: Credit.fromCents(500),
    });
    await ledger.credit("t1", Credit.fromCents(200), "purchase", "buy", "ref-1", "stripe");
    const mockCharge = vi.fn();
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it("triggers charge when balance drops below threshold", async () => {
    await settingsRepo.upsert("t1", {
      usageEnabled: true,
      usageThreshold: Credit.fromCents(100),
      usageTopup: Credit.fromCents(500),
    });
    await ledger.credit("t1", Credit.fromCents(50), "purchase", "buy", "ref-1", "stripe");
    const mockCharge = vi.fn().mockResolvedValue({ success: true, paymentReference: "pi_123" });
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).toHaveBeenCalledWith("t1", Credit.fromCents(500), "auto_topup_usage");
  });

  it("skips when charge is already in-flight", async () => {
    await settingsRepo.upsert("t1", { usageEnabled: true, usageThreshold: Credit.fromCents(100) });
    await settingsRepo.setUsageChargeInFlight("t1", true);
    await ledger.credit("t1", Credit.fromCents(50), "purchase", "buy", "ref-1", "stripe");
    const mockCharge = vi.fn();
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it("clears in-flight flag after successful charge (second call triggers new charge)", async () => {
    await settingsRepo.upsert("t1", {
      usageEnabled: true,
      usageThreshold: Credit.fromCents(100),
      usageTopup: Credit.fromCents(500),
    });
    await ledger.credit("t1", Credit.fromCents(50), "purchase", "buy", "ref-1", "stripe");
    const mockCharge = vi.fn().mockResolvedValue({ success: true, paymentReference: "pi_123" });
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    // First call — triggers charge, flag set then cleared
    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).toHaveBeenCalledTimes(1);

    // Verify flag is cleared in the database
    expect((await settingsRepo.getByTenant("t1"))?.usageChargeInFlight).toBe(false);

    // Second call — if flag was cleared, this triggers another charge
    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).toHaveBeenCalledTimes(2);
  });

  it("clears in-flight flag after charge throws error (second call triggers new charge)", async () => {
    await settingsRepo.upsert("t1", {
      usageEnabled: true,
      usageThreshold: Credit.fromCents(100),
      usageTopup: Credit.fromCents(500),
    });
    await ledger.credit("t1", Credit.fromCents(50), "purchase", "buy", "ref-1", "stripe");
    const mockCharge = vi
      .fn()
      .mockRejectedValueOnce(new Error("Stripe network error"))
      .mockResolvedValueOnce({ success: true, paymentReference: "pi_456" });
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    // First call — charge throws, caught by catch block, finally clears flag
    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).toHaveBeenCalledTimes(1);

    // Verify flag is cleared in the database despite the error
    expect((await settingsRepo.getByTenant("t1"))?.usageChargeInFlight).toBe(false);

    // Second call — if flag was cleared, this triggers another charge
    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).toHaveBeenCalledTimes(2);
  });

  it("resets failure counter on success", async () => {
    await settingsRepo.upsert("t1", {
      usageEnabled: true,
      usageThreshold: Credit.fromCents(100),
      usageTopup: Credit.fromCents(500),
    });
    await settingsRepo.incrementUsageFailures("t1");
    await settingsRepo.incrementUsageFailures("t1");
    await ledger.credit("t1", Credit.fromCents(50), "purchase", "buy", "ref-1", "stripe");
    const mockCharge = vi.fn().mockResolvedValue({ success: true });
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect((await settingsRepo.getByTenant("t1"))?.usageConsecutiveFailures).toBe(0);
  });

  it("increments failure counter on charge failure", async () => {
    await settingsRepo.upsert("t1", {
      usageEnabled: true,
      usageThreshold: Credit.fromCents(100),
      usageTopup: Credit.fromCents(500),
    });
    await ledger.credit("t1", Credit.fromCents(50), "purchase", "buy", "ref-1", "stripe");
    const mockCharge = vi.fn().mockResolvedValue({ success: false, error: "declined" });
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect((await settingsRepo.getByTenant("t1"))?.usageConsecutiveFailures).toBe(1);
  });

  it("skips charge when tenant status check returns non-null (banned/suspended)", async () => {
    // Setup: settings exist and balance is below threshold
    await settingsRepo.upsert("t1", {
      usageEnabled: true,
      usageThreshold: Credit.fromCents(1000),
      usageTopup: Credit.fromCents(2000),
    });

    const chargeAutoTopup = vi.fn();
    const checkTenantStatus = vi.fn().mockResolvedValue({ error: "account_banned", message: "banned" });

    await maybeTriggerUsageTopup({ settingsRepo, creditLedger: ledger, chargeAutoTopup, checkTenantStatus }, "t1");

    expect(chargeAutoTopup).not.toHaveBeenCalled();
  });

  it("disables usage auto-topup after 3 consecutive failures", async () => {
    await settingsRepo.upsert("t1", {
      usageEnabled: true,
      usageThreshold: Credit.fromCents(100),
      usageTopup: Credit.fromCents(500),
    });
    await settingsRepo.incrementUsageFailures("t1");
    await settingsRepo.incrementUsageFailures("t1");
    await ledger.credit("t1", Credit.fromCents(50), "purchase", "buy", "ref-1", "stripe");
    const mockCharge = vi.fn().mockResolvedValue({ success: false, error: "declined" });
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect((await settingsRepo.getByTenant("t1"))?.usageEnabled).toBe(false);
  });
});
