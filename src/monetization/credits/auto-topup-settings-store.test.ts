import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DrizzleDb } from "../../db/index.js";
import { AutoTopupSettingsStore, computeNextScheduleAt } from "./auto-topup-settings-store.js";

function setupDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE credit_auto_topup_settings (
      tenant_id TEXT PRIMARY KEY,
      usage_enabled INTEGER NOT NULL DEFAULT 0,
      usage_threshold_cents INTEGER NOT NULL DEFAULT 500,
      usage_topup_cents INTEGER NOT NULL DEFAULT 2000,
      schedule_enabled INTEGER NOT NULL DEFAULT 0,
      schedule_interval TEXT,
      schedule_amount_cents INTEGER,
      schedule_next_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return createDb(sqlite);
}

describe("AutoTopupSettingsStore", () => {
  let db: DrizzleDb;
  let store: AutoTopupSettingsStore;

  beforeEach(() => {
    db = setupDb();
    store = new AutoTopupSettingsStore(db);
  });

  describe("get", () => {
    it("returns defaults when no row exists", () => {
      const settings = store.get("tenant-1");
      expect(settings).toEqual({
        usage_enabled: false,
        usage_threshold_cents: 500,
        usage_topup_cents: 2000,
        schedule_enabled: false,
        schedule_interval: null,
        schedule_amount_cents: null,
        schedule_next_at: null,
      });
    });

    it("returns stored values when row exists", () => {
      store.upsert("tenant-1", {
        usage_enabled: true,
        usage_threshold_cents: 1000,
        usage_topup_cents: 5000,
      });
      const settings = store.get("tenant-1");
      expect(settings.usage_enabled).toBe(true);
      expect(settings.usage_threshold_cents).toBe(1000);
      expect(settings.usage_topup_cents).toBe(5000);
      expect(settings.schedule_enabled).toBe(false);
    });
  });

  describe("upsert", () => {
    it("creates row on first call", () => {
      store.upsert("tenant-1", { usage_enabled: true });
      const settings = store.get("tenant-1");
      expect(settings.usage_enabled).toBe(true);
      expect(settings.usage_threshold_cents).toBe(500); // default preserved
    });

    it("merges partial updates without touching unspecified fields", () => {
      store.upsert("tenant-1", { usage_enabled: true, usage_topup_cents: 10000 });
      store.upsert("tenant-1", { schedule_enabled: true, schedule_interval: "weekly", schedule_amount_cents: 2000 });

      const settings = store.get("tenant-1");
      expect(settings.usage_enabled).toBe(true);
      expect(settings.usage_topup_cents).toBe(10000);
      expect(settings.schedule_enabled).toBe(true);
      expect(settings.schedule_interval).toBe("weekly");
    });

    it("updates schedule_next_at when provided", () => {
      const nextAt = "2026-02-28T00:00:00Z";
      store.upsert("tenant-1", {
        schedule_enabled: true,
        schedule_interval: "monthly",
        schedule_amount_cents: 5000,
        schedule_next_at: nextAt,
      });
      const settings = store.get("tenant-1");
      expect(settings.schedule_next_at).toBe(nextAt);
    });

    it("can disable both modes", () => {
      store.upsert("tenant-1", {
        usage_enabled: true,
        schedule_enabled: true,
        schedule_interval: "daily",
        schedule_amount_cents: 500,
      });
      store.upsert("tenant-1", { usage_enabled: false, schedule_enabled: false });
      const settings = store.get("tenant-1");
      expect(settings.usage_enabled).toBe(false);
      expect(settings.schedule_enabled).toBe(false);
    });
  });
});

describe("computeNextScheduleAt", () => {
  it("returns next day at 00:00 UTC for daily", () => {
    const now = new Date("2026-02-21T14:30:00Z");
    const result = computeNextScheduleAt("daily", now);
    expect(result).toBe("2026-02-22T00:00:00.000Z");
  });

  it("returns next Monday at 00:00 UTC for weekly", () => {
    // 2026-02-21 is a Saturday
    const now = new Date("2026-02-21T14:30:00Z");
    const result = computeNextScheduleAt("weekly", now);
    expect(result).toBe("2026-02-23T00:00:00.000Z"); // next Monday
  });

  it("returns 1st of next month at 00:00 UTC for monthly", () => {
    const now = new Date("2026-02-21T14:30:00Z");
    const result = computeNextScheduleAt("monthly", now);
    expect(result).toBe("2026-03-01T00:00:00.000Z");
  });

  it("handles year rollover for monthly", () => {
    const now = new Date("2026-12-15T10:00:00Z");
    const result = computeNextScheduleAt("monthly", now);
    expect(result).toBe("2027-01-01T00:00:00.000Z");
  });

  it("returns null for null interval", () => {
    const result = computeNextScheduleAt(null);
    expect(result).toBeNull();
  });
});
