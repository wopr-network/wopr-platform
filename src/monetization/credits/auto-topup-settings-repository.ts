import { and, eq, lte, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditAutoTopupSettings } from "../../db/schema/credit-auto-topup-settings.js";

export interface AutoTopupSettings {
  tenantId: string;
  usageEnabled: boolean;
  usageThresholdCents: number;
  usageTopupCents: number;
  usageConsecutiveFailures: number;
  usageChargeInFlight: boolean;
  scheduleEnabled: boolean;
  scheduleAmountCents: number;
  scheduleIntervalHours: number;
  scheduleNextAt: string | null;
  scheduleConsecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface IAutoTopupSettingsRepository {
  getByTenant(tenantId: string): AutoTopupSettings | null;
  upsert(tenantId: string, settings: Partial<Omit<AutoTopupSettings, "tenantId" | "createdAt" | "updatedAt">>): void;
  setUsageChargeInFlight(tenantId: string, inFlight: boolean): void;
  incrementUsageFailures(tenantId: string): number;
  resetUsageFailures(tenantId: string): void;
  disableUsage(tenantId: string): void;
  incrementScheduleFailures(tenantId: string): number;
  resetScheduleFailures(tenantId: string): void;
  disableSchedule(tenantId: string): void;
  advanceScheduleNextAt(tenantId: string): void;
  listDueScheduled(now: string): AutoTopupSettings[];
}

export class DrizzleAutoTopupSettingsRepository implements IAutoTopupSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  getByTenant(tenantId: string): AutoTopupSettings | null {
    const row = this.db
      .select()
      .from(creditAutoTopupSettings)
      .where(eq(creditAutoTopupSettings.tenantId, tenantId))
      .get();
    return row ? mapRow(row) : null;
  }

  upsert(tenantId: string, settings: Partial<Omit<AutoTopupSettings, "tenantId" | "createdAt" | "updatedAt">>): void {
    const now = sql`(datetime('now'))` as unknown as string;
    const values: typeof creditAutoTopupSettings.$inferInsert = {
      tenantId,
      updatedAt: now,
    };
    const updateSet: Record<string, unknown> = { updatedAt: now };

    if (settings.usageEnabled !== undefined) {
      values.usageEnabled = settings.usageEnabled ? 1 : 0;
      updateSet.usageEnabled = values.usageEnabled;
    }
    if (settings.usageThresholdCents !== undefined) {
      values.usageThresholdCents = settings.usageThresholdCents;
      updateSet.usageThresholdCents = settings.usageThresholdCents;
    }
    if (settings.usageTopupCents !== undefined) {
      values.usageTopupCents = settings.usageTopupCents;
      updateSet.usageTopupCents = settings.usageTopupCents;
    }
    if (settings.scheduleEnabled !== undefined) {
      values.scheduleEnabled = settings.scheduleEnabled ? 1 : 0;
      updateSet.scheduleEnabled = values.scheduleEnabled;
    }
    if (settings.scheduleAmountCents !== undefined) {
      values.scheduleAmountCents = settings.scheduleAmountCents;
      updateSet.scheduleAmountCents = settings.scheduleAmountCents;
    }
    if (settings.scheduleIntervalHours !== undefined) {
      values.scheduleIntervalHours = settings.scheduleIntervalHours;
      updateSet.scheduleIntervalHours = settings.scheduleIntervalHours;
    }
    if (settings.scheduleNextAt !== undefined) {
      values.scheduleNextAt = settings.scheduleNextAt;
      updateSet.scheduleNextAt = settings.scheduleNextAt;
    }

    this.db
      .insert(creditAutoTopupSettings)
      .values(values)
      .onConflictDoUpdate({ target: creditAutoTopupSettings.tenantId, set: updateSet })
      .run();
  }

  setUsageChargeInFlight(tenantId: string, inFlight: boolean): void {
    this.db
      .update(creditAutoTopupSettings)
      .set({ usageChargeInFlight: inFlight ? 1 : 0, updatedAt: sql`(datetime('now'))` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId))
      .run();
  }

  incrementUsageFailures(tenantId: string): number {
    this.db
      .update(creditAutoTopupSettings)
      .set({
        usageConsecutiveFailures: sql`${creditAutoTopupSettings.usageConsecutiveFailures} + 1`,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId))
      .run();
    const row = this.getByTenant(tenantId);
    return row?.usageConsecutiveFailures ?? 0;
  }

  resetUsageFailures(tenantId: string): void {
    this.db
      .update(creditAutoTopupSettings)
      .set({ usageConsecutiveFailures: 0, updatedAt: sql`(datetime('now'))` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId))
      .run();
  }

  disableUsage(tenantId: string): void {
    this.db
      .update(creditAutoTopupSettings)
      .set({ usageEnabled: 0, updatedAt: sql`(datetime('now'))` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId))
      .run();
  }

  incrementScheduleFailures(tenantId: string): number {
    this.db
      .update(creditAutoTopupSettings)
      .set({
        scheduleConsecutiveFailures: sql`${creditAutoTopupSettings.scheduleConsecutiveFailures} + 1`,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId))
      .run();
    const row = this.getByTenant(tenantId);
    return row?.scheduleConsecutiveFailures ?? 0;
  }

  resetScheduleFailures(tenantId: string): void {
    this.db
      .update(creditAutoTopupSettings)
      .set({ scheduleConsecutiveFailures: 0, updatedAt: sql`(datetime('now'))` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId))
      .run();
  }

  disableSchedule(tenantId: string): void {
    this.db
      .update(creditAutoTopupSettings)
      .set({ scheduleEnabled: 0, updatedAt: sql`(datetime('now'))` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId))
      .run();
  }

  advanceScheduleNextAt(tenantId: string): void {
    const settings = this.getByTenant(tenantId);
    if (!settings?.scheduleNextAt) return;

    const currentNext = new Date(settings.scheduleNextAt);
    const newNext = new Date(currentNext.getTime() + settings.scheduleIntervalHours * 60 * 60 * 1000);

    this.db
      .update(creditAutoTopupSettings)
      .set({ scheduleNextAt: newNext.toISOString(), updatedAt: sql`(datetime('now'))` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId))
      .run();
  }

  listDueScheduled(now: string): AutoTopupSettings[] {
    const rows = this.db
      .select()
      .from(creditAutoTopupSettings)
      .where(and(eq(creditAutoTopupSettings.scheduleEnabled, 1), lte(creditAutoTopupSettings.scheduleNextAt, now)))
      .all();
    return rows.map(mapRow);
  }
}

function mapRow(row: typeof creditAutoTopupSettings.$inferSelect): AutoTopupSettings {
  return {
    tenantId: row.tenantId,
    usageEnabled: row.usageEnabled === 1,
    usageThresholdCents: row.usageThresholdCents,
    usageTopupCents: row.usageTopupCents,
    usageConsecutiveFailures: row.usageConsecutiveFailures,
    usageChargeInFlight: row.usageChargeInFlight === 1,
    scheduleEnabled: row.scheduleEnabled === 1,
    scheduleAmountCents: row.scheduleAmountCents,
    scheduleIntervalHours: row.scheduleIntervalHours,
    scheduleNextAt: row.scheduleNextAt ?? null,
    scheduleConsecutiveFailures: row.scheduleConsecutiveFailures,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Backward-compat alias
export { DrizzleAutoTopupSettingsRepository as AutoTopupSettingsRepository };

// ---------------------------------------------------------------------------
// Constants for tRPC validation
// ---------------------------------------------------------------------------

export const ALLOWED_TOPUP_AMOUNTS_CENTS = [500, 1000, 2000, 5000, 10000, 20000, 50000] as const;
export const ALLOWED_THRESHOLD_CENTS = [200, 500, 1000] as const;
export const ALLOWED_SCHEDULE_INTERVALS = ["daily", "weekly", "monthly"] as const;

// ---------------------------------------------------------------------------
// Schedule helper
// ---------------------------------------------------------------------------

/**
 * Compute the next schedule_next_at timestamp based on the interval.
 * Always returns the next occurrence at 00:00 UTC.
 */
export function computeNextScheduleAt(
  interval: "daily" | "weekly" | "monthly" | null,
  now: Date = new Date(),
): string | null {
  if (!interval) return null;

  switch (interval) {
    case "daily": {
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      return next.toISOString();
    }
    case "weekly": {
      // Next Monday
      const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon, ...
      const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));
      return next.toISOString();
    }
    case "monthly": {
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return next.toISOString();
    }
  }
}
