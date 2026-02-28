import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { Credit } from "../credit.js";
import { runScheduledTopups, type ScheduleTopupDeps } from "./auto-topup-schedule.js";
import { DrizzleAutoTopupSettingsRepository } from "./auto-topup-settings-repository.js";

describe("runScheduledTopups", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let settingsRepo: DrizzleAutoTopupSettingsRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    settingsRepo = new DrizzleAutoTopupSettingsRepository(db);
  });

  afterEach(async () => {
    await pool.close();
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
    const past = "2026-02-20T00:00:00.000Z";
    await settingsRepo.upsert("t1", {
      scheduleEnabled: true,
      scheduleAmount: Credit.fromCents(1000),
      scheduleNextAt: past,
    });

    const mockCharge = vi.fn().mockResolvedValue({ success: true, paymentReference: "pi_abc" });
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    const result = await runScheduledTopups(deps);
    expect(result.processed).toBe(1);
    expect(result.succeeded).toEqual(["t1"]);
    expect(mockCharge).toHaveBeenCalledWith("t1", Credit.fromCents(1000), "auto_topup_schedule");
  });

  it("resets failure counter on success", async () => {
    const past = "2026-02-20T00:00:00.000Z";
    await settingsRepo.upsert("t1", {
      scheduleEnabled: true,
      scheduleAmount: Credit.fromCents(500),
      scheduleNextAt: past,
    });
    await settingsRepo.incrementScheduleFailures("t1");
    await settingsRepo.incrementScheduleFailures("t1");

    const mockCharge = vi.fn().mockResolvedValue({ success: true });
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    await runScheduledTopups(deps);
    expect((await settingsRepo.getByTenant("t1"))?.scheduleConsecutiveFailures).toBe(0);
  });

  it("advances scheduleNextAt after successful charge", async () => {
    const past = "2026-02-20T00:00:00.000Z";
    await settingsRepo.upsert("t1", {
      scheduleEnabled: true,
      scheduleAmount: Credit.fromCents(1000),
      scheduleIntervalHours: 24,
      scheduleNextAt: past,
    });

    const before = (await settingsRepo.getByTenant("t1"))?.scheduleNextAt;

    const mockCharge = vi.fn().mockResolvedValue({ success: true, paymentReference: "pi_ok" });
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    await runScheduledTopups(deps);

    const after = (await settingsRepo.getByTenant("t1"))?.scheduleNextAt;
    expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before!).getTime());
  });

  it("advances scheduleNextAt after charge throws an error", async () => {
    const past = "2026-02-20T00:00:00.000Z";
    await settingsRepo.upsert("t1", {
      scheduleEnabled: true,
      scheduleAmount: Credit.fromCents(1000),
      scheduleIntervalHours: 24,
      scheduleNextAt: past,
    });

    const before = (await settingsRepo.getByTenant("t1"))?.scheduleNextAt;

    const mockCharge = vi.fn().mockRejectedValue(new Error("Stripe network error"));
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    await runScheduledTopups(deps);

    const after = (await settingsRepo.getByTenant("t1"))?.scheduleNextAt;
    expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before!).getTime());
  });

  it("disables schedule after 3 consecutive failures", async () => {
    const past = "2026-02-20T00:00:00.000Z";
    await settingsRepo.upsert("t1", {
      scheduleEnabled: true,
      scheduleAmount: Credit.fromCents(500),
      scheduleNextAt: past,
    });
    await settingsRepo.incrementScheduleFailures("t1");
    await settingsRepo.incrementScheduleFailures("t1");

    const mockCharge = vi.fn().mockResolvedValue({ success: false, error: "declined" });
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    await runScheduledTopups(deps);
    expect((await settingsRepo.getByTenant("t1"))?.scheduleEnabled).toBe(false);
  });

  it("skips tenants where checkTenantStatus returns non-null", async () => {
    // Setup: one due tenant that is banned
    await settingsRepo.upsert("t-banned", {
      scheduleEnabled: true,
      scheduleAmount: Credit.fromCents(1000),
      scheduleIntervalHours: 24,
      scheduleNextAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const chargeAutoTopup = vi.fn();
    const checkTenantStatus = vi.fn().mockResolvedValue({ error: "account_banned", message: "banned" });

    const result = await runScheduledTopups({
      settingsRepo,
      chargeAutoTopup,
      checkTenantStatus,
    });

    expect(chargeAutoTopup).not.toHaveBeenCalled();
    // The tenant should still be processed (counter incremented) but skipped
    expect(result.processed).toBe(1);
    expect(result.failed).toContain("t-banned");
  });

  it("processes multiple tenants independently", async () => {
    const past = "2026-02-20T00:00:00.000Z";
    await settingsRepo.upsert("t1", {
      scheduleEnabled: true,
      scheduleAmount: Credit.fromCents(500),
      scheduleNextAt: past,
    });
    await settingsRepo.upsert("t2", {
      scheduleEnabled: true,
      scheduleAmount: Credit.fromCents(1000),
      scheduleNextAt: past,
    });

    const mockCharge = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "declined" });
    const deps: ScheduleTopupDeps = { settingsRepo, chargeAutoTopup: mockCharge };

    const result = await runScheduledTopups(deps);
    expect(result.processed).toBe(2);
    expect(result.succeeded).toContain("t1");
    expect(result.failed).toContain("t2");
  });
});
