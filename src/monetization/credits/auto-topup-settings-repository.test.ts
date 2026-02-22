import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { AutoTopupSettingsRepository } from "./auto-topup-settings-repository.js";

function initTestSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS credit_auto_topup_settings (
      tenant_id TEXT PRIMARY KEY,
      usage_enabled INTEGER NOT NULL DEFAULT 0,
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
}

describe("AutoTopupSettingsRepository", () => {
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let repo: AutoTopupSettingsRepository;

  beforeEach(() => {
    sqlite = new BetterSqlite3(":memory:");
    initTestSchema(sqlite);
    db = createDb(sqlite);
    repo = new AutoTopupSettingsRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns null for unknown tenant", () => {
    expect(repo.getByTenant("unknown")).toBeNull();
  });

  it("upsert creates settings and getByTenant retrieves them", () => {
    repo.upsert("t1", { usageEnabled: true, usageThresholdCents: 200, usageTopupCents: 1000 });
    const s = repo.getByTenant("t1");
    expect(s).not.toBeNull();
    expect(s?.usageEnabled).toBe(true);
    expect(s?.usageThresholdCents).toBe(200);
    expect(s?.usageTopupCents).toBe(1000);
    expect(s?.scheduleEnabled).toBe(false);
  });

  it("upsert updates existing settings", () => {
    repo.upsert("t1", { usageEnabled: true });
    repo.upsert("t1", { usageThresholdCents: 300 });
    const s = repo.getByTenant("t1");
    expect(s?.usageEnabled).toBe(true);
    expect(s?.usageThresholdCents).toBe(300);
  });

  it("setUsageChargeInFlight toggles the flag", () => {
    repo.upsert("t1", { usageEnabled: true });
    repo.setUsageChargeInFlight("t1", true);
    expect(repo.getByTenant("t1")?.usageChargeInFlight).toBe(true);
    repo.setUsageChargeInFlight("t1", false);
    expect(repo.getByTenant("t1")?.usageChargeInFlight).toBe(false);
  });

  it("incrementUsageFailures increments and returns count", () => {
    repo.upsert("t1", { usageEnabled: true });
    expect(repo.incrementUsageFailures("t1")).toBe(1);
    expect(repo.incrementUsageFailures("t1")).toBe(2);
    expect(repo.incrementUsageFailures("t1")).toBe(3);
  });

  it("resetUsageFailures resets to zero", () => {
    repo.upsert("t1", { usageEnabled: true });
    repo.incrementUsageFailures("t1");
    repo.incrementUsageFailures("t1");
    repo.resetUsageFailures("t1");
    expect(repo.getByTenant("t1")?.usageConsecutiveFailures).toBe(0);
  });

  it("disableUsage sets usage_enabled to false", () => {
    repo.upsert("t1", { usageEnabled: true });
    repo.disableUsage("t1");
    expect(repo.getByTenant("t1")?.usageEnabled).toBe(false);
  });

  it("incrementScheduleFailures increments and returns count", () => {
    repo.upsert("t1", { scheduleEnabled: true });
    expect(repo.incrementScheduleFailures("t1")).toBe(1);
    expect(repo.incrementScheduleFailures("t1")).toBe(2);
  });

  it("disableSchedule sets schedule_enabled to false", () => {
    repo.upsert("t1", { scheduleEnabled: true });
    repo.disableSchedule("t1");
    expect(repo.getByTenant("t1")?.scheduleEnabled).toBe(false);
  });

  it("advanceScheduleNextAt adds interval hours to current scheduleNextAt", () => {
    const now = "2026-02-22T00:00:00.000Z";
    repo.upsert("t1", { scheduleEnabled: true, scheduleIntervalHours: 24 });
    // Manually set scheduleNextAt
    repo.upsert("t1", { scheduleEnabled: true });
    // Use the repo to set a known time
    sqlite.exec(`UPDATE credit_auto_topup_settings SET schedule_next_at = '${now}' WHERE tenant_id = 't1'`);
    repo.advanceScheduleNextAt("t1");
    const s = repo.getByTenant("t1");
    expect(s?.scheduleNextAt).toBe("2026-02-23T00:00:00.000Z");
  });

  it("listDueScheduled returns tenants with schedule_next_at <= now", () => {
    repo.upsert("t1", { scheduleEnabled: true, scheduleAmountCents: 500 });
    repo.upsert("t2", { scheduleEnabled: true, scheduleAmountCents: 1000 });
    repo.upsert("t3", { scheduleEnabled: false });
    const past = "2026-02-20T00:00:00.000Z";
    const future = "2026-12-31T00:00:00.000Z";
    sqlite.exec(`UPDATE credit_auto_topup_settings SET schedule_next_at = '${past}' WHERE tenant_id = 't1'`);
    sqlite.exec(`UPDATE credit_auto_topup_settings SET schedule_next_at = '${future}' WHERE tenant_id = 't2'`);
    sqlite.exec(`UPDATE credit_auto_topup_settings SET schedule_next_at = '${past}' WHERE tenant_id = 't3'`);

    const due = repo.listDueScheduled("2026-02-22T00:00:00.000Z");
    expect(due).toHaveLength(1);
    expect(due[0].tenantId).toBe("t1");
  });
});
