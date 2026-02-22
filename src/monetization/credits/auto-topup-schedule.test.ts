import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { runScheduledTopups, type ScheduleTopupDeps } from "./auto-topup-schedule.js";
import { AutoTopupSettingsRepository } from "./auto-topup-settings-repository.js";

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

describe("runScheduledTopups", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let settingsRepo: AutoTopupSettingsRepository;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    db = createDb(sqlite);
    settingsRepo = new AutoTopupSettingsRepository(db);
  });

  afterEach(() => {
    sqlite.close();
    db; // suppress unused warning
  });

  it("processes no tenants when none are due", async () => {
    const mockCharge = vi.fn();
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    const result = await runScheduledTopups(deps);
    expect(result.processed).toBe(0);
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(mockCharge).not.toHaveBeenCalled();
  });

  it("charges tenant whose schedule_next_at is in the past", async () => {
    settingsRepo.upsert("t1", { scheduleEnabled: true, scheduleAmountCents: 1000, scheduleIntervalHours: 24 });
    sqlite.exec(
      `UPDATE credit_auto_topup_settings SET schedule_next_at = '2026-02-20T00:00:00.000Z' WHERE tenant_id = 't1'`,
    );

    const mockCharge = vi.fn().mockResolvedValue({ success: true, paymentReference: "pi_abc" });
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    const result = await runScheduledTopups(deps);
    expect(result.processed).toBe(1);
    expect(result.succeeded).toEqual(["t1"]);
    expect(mockCharge).toHaveBeenCalledWith("t1", 1000, "auto_topup_schedule");
  });

  it("advances schedule_next_at after successful charge", async () => {
    settingsRepo.upsert("t1", { scheduleEnabled: true, scheduleAmountCents: 500, scheduleIntervalHours: 24 });
    sqlite.exec(
      `UPDATE credit_auto_topup_settings SET schedule_next_at = '2026-02-20T00:00:00.000Z' WHERE tenant_id = 't1'`,
    );

    const mockCharge = vi.fn().mockResolvedValue({ success: true });
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    await runScheduledTopups(deps);
    const s = settingsRepo.getByTenant("t1");
    expect(s?.scheduleNextAt).toBe("2026-02-21T00:00:00.000Z");
  });

  it("advances schedule_next_at even on failure", async () => {
    settingsRepo.upsert("t1", { scheduleEnabled: true, scheduleAmountCents: 500, scheduleIntervalHours: 24 });
    sqlite.exec(
      `UPDATE credit_auto_topup_settings SET schedule_next_at = '2026-02-20T00:00:00.000Z' WHERE tenant_id = 't1'`,
    );

    const mockCharge = vi.fn().mockResolvedValue({ success: false, error: "declined" });
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    await runScheduledTopups(deps);
    const s = settingsRepo.getByTenant("t1");
    expect(s?.scheduleNextAt).toBe("2026-02-21T00:00:00.000Z");
  });

  it("resets failure counter on success", async () => {
    settingsRepo.upsert("t1", { scheduleEnabled: true, scheduleAmountCents: 500 });
    settingsRepo.incrementScheduleFailures("t1");
    settingsRepo.incrementScheduleFailures("t1");
    sqlite.exec(
      `UPDATE credit_auto_topup_settings SET schedule_next_at = '2026-02-20T00:00:00.000Z' WHERE tenant_id = 't1'`,
    );

    const mockCharge = vi.fn().mockResolvedValue({ success: true });
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    await runScheduledTopups(deps);
    expect(settingsRepo.getByTenant("t1")?.scheduleConsecutiveFailures).toBe(0);
  });

  it("disables schedule after 3 consecutive failures", async () => {
    settingsRepo.upsert("t1", { scheduleEnabled: true, scheduleAmountCents: 500, scheduleIntervalHours: 24 });
    settingsRepo.incrementScheduleFailures("t1");
    settingsRepo.incrementScheduleFailures("t1"); // now at 2
    sqlite.exec(
      `UPDATE credit_auto_topup_settings SET schedule_next_at = '2026-02-20T00:00:00.000Z' WHERE tenant_id = 't1'`,
    );

    const mockCharge = vi.fn().mockResolvedValue({ success: false, error: "declined" });
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    await runScheduledTopups(deps); // failures goes to 3
    expect(settingsRepo.getByTenant("t1")?.scheduleEnabled).toBe(false);
  });

  it("processes multiple tenants independently", async () => {
    settingsRepo.upsert("t1", { scheduleEnabled: true, scheduleAmountCents: 500, scheduleIntervalHours: 24 });
    settingsRepo.upsert("t2", { scheduleEnabled: true, scheduleAmountCents: 1000, scheduleIntervalHours: 168 });
    const past = "2026-02-20T00:00:00.000Z";
    sqlite.exec(`UPDATE credit_auto_topup_settings SET schedule_next_at = '${past}' WHERE tenant_id IN ('t1', 't2')`);

    const mockCharge = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "declined" });
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    const result = await runScheduledTopups(deps);
    expect(result.processed).toBe(2);
    expect(result.succeeded).toEqual(["t1"]);
    expect(result.failed).toEqual(["t2"]);
  });
});
