import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../../db/index.js";
import { createTestDb } from "../../test/db.js";
import { DrizzleAutoTopupSettingsRepository } from "./auto-topup-settings-repository.js";

describe("DrizzleAutoTopupSettingsRepository", () => {
  let pool: PGlite;
  let db: DrizzleDb;
  let repo: DrizzleAutoTopupSettingsRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    repo = new DrizzleAutoTopupSettingsRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  it("returns null for unknown tenant", async () => {
    expect(await repo.getByTenant("unknown")).toBeNull();
  });

  it("upsert creates settings and getByTenant retrieves them", async () => {
    await repo.upsert("t1", { usageEnabled: true, usageThresholdCents: 200, usageTopupCents: 1000 });
    const s = await repo.getByTenant("t1");
    expect(s).not.toBeNull();
    expect(s?.usageEnabled).toBe(true);
    expect(s?.usageThresholdCents).toBe(200);
    expect(s?.usageTopupCents).toBe(1000);
    expect(s?.scheduleEnabled).toBe(false);
  });

  it("upsert updates existing settings", async () => {
    await repo.upsert("t1", { usageEnabled: true });
    await repo.upsert("t1", { usageThresholdCents: 300 });
    const s = await repo.getByTenant("t1");
    expect(s?.usageEnabled).toBe(true);
    expect(s?.usageThresholdCents).toBe(300);
  });

  it("setUsageChargeInFlight toggles the flag", async () => {
    await repo.upsert("t1", { usageEnabled: true });
    await repo.setUsageChargeInFlight("t1", true);
    expect((await repo.getByTenant("t1"))?.usageChargeInFlight).toBe(true);
    await repo.setUsageChargeInFlight("t1", false);
    expect((await repo.getByTenant("t1"))?.usageChargeInFlight).toBe(false);
  });

  it("incrementUsageFailures increments and returns count", async () => {
    await repo.upsert("t1", { usageEnabled: true });
    expect(await repo.incrementUsageFailures("t1")).toBe(1);
    expect(await repo.incrementUsageFailures("t1")).toBe(2);
    expect(await repo.incrementUsageFailures("t1")).toBe(3);
  });

  it("resetUsageFailures resets to zero", async () => {
    await repo.upsert("t1", { usageEnabled: true });
    await repo.incrementUsageFailures("t1");
    await repo.incrementUsageFailures("t1");
    await repo.resetUsageFailures("t1");
    expect((await repo.getByTenant("t1"))?.usageConsecutiveFailures).toBe(0);
  });

  it("disableUsage sets usage_enabled to false", async () => {
    await repo.upsert("t1", { usageEnabled: true });
    await repo.disableUsage("t1");
    expect((await repo.getByTenant("t1"))?.usageEnabled).toBe(false);
  });

  it("incrementScheduleFailures increments and returns count", async () => {
    await repo.upsert("t1", { scheduleEnabled: true });
    expect(await repo.incrementScheduleFailures("t1")).toBe(1);
    expect(await repo.incrementScheduleFailures("t1")).toBe(2);
  });

  it("disableSchedule sets schedule_enabled to false", async () => {
    await repo.upsert("t1", { scheduleEnabled: true });
    await repo.disableSchedule("t1");
    expect((await repo.getByTenant("t1"))?.scheduleEnabled).toBe(false);
  });

  it("listDueScheduled returns tenants with schedule_next_at <= now", async () => {
    const past = "2026-02-20T00:00:00.000Z";
    const future = "2026-12-31T00:00:00.000Z";
    await repo.upsert("t1", { scheduleEnabled: true, scheduleAmountCents: 500, scheduleNextAt: past });
    await repo.upsert("t2", { scheduleEnabled: true, scheduleAmountCents: 1000, scheduleNextAt: future });
    await repo.upsert("t3", { scheduleEnabled: false, scheduleNextAt: past });

    const due = await repo.listDueScheduled("2026-02-22T00:00:00.000Z");
    expect(due).toHaveLength(1);
    expect(due[0].tenantId).toBe("t1");
  });
});
