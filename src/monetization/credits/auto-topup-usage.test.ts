import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { AutoTopupSettingsRepository } from "./auto-topup-settings-repository.js";
import { maybeTriggerUsageTopup, type UsageTopupDeps } from "./auto-topup-usage.js";
import { CreditLedger } from "./credit-ledger.js";

function initTestSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      balance_after_cents INTEGER NOT NULL, type TEXT NOT NULL, description TEXT,
      reference_id TEXT UNIQUE, funding_source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_balances (
      tenant_id TEXT PRIMARY KEY, balance_cents INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_auto_topup_settings (
      tenant_id TEXT PRIMARY KEY, usage_enabled INTEGER NOT NULL DEFAULT 0,
      usage_threshold_cents INTEGER NOT NULL DEFAULT 100,
      usage_topup_cents INTEGER NOT NULL DEFAULT 500,
      usage_consecutive_failures INTEGER NOT NULL DEFAULT 0,
      usage_charge_in_flight INTEGER NOT NULL DEFAULT 0,
      schedule_enabled INTEGER NOT NULL DEFAULT 0,
      schedule_amount_cents INTEGER NOT NULL DEFAULT 500,
      schedule_interval_hours INTEGER NOT NULL DEFAULT 168,
      schedule_next_at TEXT,
      schedule_consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_auto_topup (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL, failure_reason TEXT, payment_reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

describe("maybeTriggerUsageTopup", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let ledger: CreditLedger;
  let settingsRepo: AutoTopupSettingsRepository;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    db = createDb(sqlite);
    ledger = new CreditLedger(db);
    settingsRepo = new AutoTopupSettingsRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("does nothing when tenant has no auto-topup settings", async () => {
    const mockCharge = vi.fn();
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it("does nothing when usage_enabled is false", async () => {
    settingsRepo.upsert("t1", { usageEnabled: false });
    ledger.credit("t1", 50, "purchase");
    const mockCharge = vi.fn();
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it("does nothing when balance is above threshold", async () => {
    settingsRepo.upsert("t1", { usageEnabled: true, usageThresholdCents: 100, usageTopupCents: 500 });
    ledger.credit("t1", 200, "purchase");
    const mockCharge = vi.fn();
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it("triggers charge when balance drops below threshold", async () => {
    settingsRepo.upsert("t1", { usageEnabled: true, usageThresholdCents: 100, usageTopupCents: 500 });
    ledger.credit("t1", 50, "purchase"); // balance = 50, below threshold of 100
    const mockCharge = vi.fn().mockResolvedValue({ success: true, paymentReference: "pi_123" });
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).toHaveBeenCalledWith("t1", 500, "auto_topup_usage");
  });

  it("sets in-flight flag before charge and clears after success", async () => {
    settingsRepo.upsert("t1", { usageEnabled: true, usageThresholdCents: 100, usageTopupCents: 500 });
    ledger.credit("t1", 50, "purchase");

    const mockCharge = vi.fn().mockImplementation(async () => {
      expect(settingsRepo.getByTenant("t1")?.usageChargeInFlight).toBe(true);
      return { success: true, paymentReference: "pi_123" };
    });
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(settingsRepo.getByTenant("t1")?.usageChargeInFlight).toBe(false);
  });

  it("skips when charge is already in-flight", async () => {
    settingsRepo.upsert("t1", { usageEnabled: true, usageThresholdCents: 100 });
    settingsRepo.setUsageChargeInFlight("t1", true);
    ledger.credit("t1", 50, "purchase");
    const mockCharge = vi.fn();
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it("resets failure counter on success", async () => {
    settingsRepo.upsert("t1", { usageEnabled: true, usageThresholdCents: 100, usageTopupCents: 500 });
    settingsRepo.incrementUsageFailures("t1");
    settingsRepo.incrementUsageFailures("t1");
    ledger.credit("t1", 50, "purchase");
    const mockCharge = vi.fn().mockResolvedValue({ success: true });
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(settingsRepo.getByTenant("t1")?.usageConsecutiveFailures).toBe(0);
  });

  it("increments failure counter on charge failure", async () => {
    settingsRepo.upsert("t1", { usageEnabled: true, usageThresholdCents: 100, usageTopupCents: 500 });
    ledger.credit("t1", 50, "purchase");
    const mockCharge = vi.fn().mockResolvedValue({ success: false, error: "declined" });
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1");
    expect(settingsRepo.getByTenant("t1")?.usageConsecutiveFailures).toBe(1);
  });

  it("disables usage auto-topup after 3 consecutive failures", async () => {
    settingsRepo.upsert("t1", { usageEnabled: true, usageThresholdCents: 100, usageTopupCents: 500 });
    settingsRepo.incrementUsageFailures("t1");
    settingsRepo.incrementUsageFailures("t1"); // now at 2
    ledger.credit("t1", 50, "purchase");
    const mockCharge = vi.fn().mockResolvedValue({ success: false, error: "declined" });
    const deps: UsageTopupDeps = { settingsRepo, creditLedger: ledger, chargeAutoTopup: mockCharge };

    await maybeTriggerUsageTopup(deps, "t1"); // failures goes to 3
    expect(settingsRepo.getByTenant("t1")?.usageEnabled).toBe(false);
  });
});
