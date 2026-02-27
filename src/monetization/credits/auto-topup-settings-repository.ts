import { and, eq, lte, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditAutoTopupSettings } from "../../db/schema/credit-auto-topup-settings.js";

export const ALLOWED_TOPUP_AMOUNTS_CREDITS = [500, 1000, 2000, 5000, 10000, 20000, 50000] as const;
export const ALLOWED_THRESHOLD_CREDITS = [200, 500, 1000] as const;
export const ALLOWED_SCHEDULE_INTERVALS = ["daily", "weekly", "monthly"] as const;

export function computeNextScheduleAt(
  interval: "daily" | "weekly" | "monthly" | null,
  now: Date = new Date(),
): string | null {
  if (!interval) return null;
  const next = new Date(now);
  if (interval === "daily") {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(0, 0, 0, 0);
  } else if (interval === "weekly") {
    next.setUTCDate(next.getUTCDate() + 7);
    next.setUTCHours(0, 0, 0, 0);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(1);
    next.setUTCHours(0, 0, 0, 0);
  }
  return next.toISOString();
}

export interface AutoTopupSettings {
  tenantId: string;
  usageEnabled: boolean;
  usageThresholdCredits: number;
  usageTopupCredits: number;
  usageConsecutiveFailures: number;
  usageChargeInFlight: boolean;
  scheduleEnabled: boolean;
  scheduleAmountCredits: number;
  scheduleIntervalHours: number;
  scheduleNextAt: string | null;
  scheduleConsecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface IAutoTopupSettingsRepository {
  getByTenant(tenantId: string): Promise<AutoTopupSettings | null>;
  upsert(
    tenantId: string,
    settings: Partial<Omit<AutoTopupSettings, "tenantId" | "createdAt" | "updatedAt">>,
  ): Promise<void>;
  setUsageChargeInFlight(tenantId: string, inFlight: boolean): Promise<void>;
  incrementUsageFailures(tenantId: string): Promise<number>;
  resetUsageFailures(tenantId: string): Promise<void>;
  disableUsage(tenantId: string): Promise<void>;
  incrementScheduleFailures(tenantId: string): Promise<number>;
  resetScheduleFailures(tenantId: string): Promise<void>;
  disableSchedule(tenantId: string): Promise<void>;
  advanceScheduleNextAt(tenantId: string): Promise<void>;
  listDueScheduled(now: string): Promise<AutoTopupSettings[]>;
}

export class DrizzleAutoTopupSettingsRepository implements IAutoTopupSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByTenant(tenantId: string): Promise<AutoTopupSettings | null> {
    const row = (
      await this.db.select().from(creditAutoTopupSettings).where(eq(creditAutoTopupSettings.tenantId, tenantId))
    )[0];
    return row ? mapRow(row) : null;
  }

  async upsert(
    tenantId: string,
    settings: Partial<Omit<AutoTopupSettings, "tenantId" | "createdAt" | "updatedAt">>,
  ): Promise<void> {
    const now = sql`now()` as unknown as string;
    const values: typeof creditAutoTopupSettings.$inferInsert = {
      tenantId,
      updatedAt: now,
    };
    const updateSet: Record<string, unknown> = { updatedAt: now };

    if (settings.usageEnabled !== undefined) {
      values.usageEnabled = settings.usageEnabled ? 1 : 0;
      updateSet.usageEnabled = values.usageEnabled;
    }
    if (settings.usageThresholdCredits !== undefined) {
      values.usageThresholdCredits = settings.usageThresholdCredits;
      updateSet.usageThresholdCredits = settings.usageThresholdCredits;
    }
    if (settings.usageTopupCredits !== undefined) {
      values.usageTopupCredits = settings.usageTopupCredits;
      updateSet.usageTopupCredits = settings.usageTopupCredits;
    }
    if (settings.scheduleEnabled !== undefined) {
      values.scheduleEnabled = settings.scheduleEnabled ? 1 : 0;
      updateSet.scheduleEnabled = values.scheduleEnabled;
    }
    if (settings.scheduleAmountCredits !== undefined) {
      values.scheduleAmountCredits = settings.scheduleAmountCredits;
      updateSet.scheduleAmountCredits = settings.scheduleAmountCredits;
    }
    if (settings.scheduleIntervalHours !== undefined) {
      values.scheduleIntervalHours = settings.scheduleIntervalHours;
      updateSet.scheduleIntervalHours = settings.scheduleIntervalHours;
    }
    if (settings.scheduleNextAt !== undefined) {
      values.scheduleNextAt = settings.scheduleNextAt;
      updateSet.scheduleNextAt = settings.scheduleNextAt;
    }

    await this.db
      .insert(creditAutoTopupSettings)
      .values(values)
      .onConflictDoUpdate({ target: creditAutoTopupSettings.tenantId, set: updateSet });
  }

  async setUsageChargeInFlight(tenantId: string, inFlight: boolean): Promise<void> {
    await this.db
      .update(creditAutoTopupSettings)
      .set({ usageChargeInFlight: inFlight ? 1 : 0, updatedAt: sql`now()` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId));
  }

  async incrementUsageFailures(tenantId: string): Promise<number> {
    await this.db
      .update(creditAutoTopupSettings)
      .set({
        usageConsecutiveFailures: sql`${creditAutoTopupSettings.usageConsecutiveFailures} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId));
    const row = await this.getByTenant(tenantId);
    return row?.usageConsecutiveFailures ?? 0;
  }

  async resetUsageFailures(tenantId: string): Promise<void> {
    await this.db
      .update(creditAutoTopupSettings)
      .set({ usageConsecutiveFailures: 0, updatedAt: sql`now()` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId));
  }

  async disableUsage(tenantId: string): Promise<void> {
    await this.db
      .update(creditAutoTopupSettings)
      .set({ usageEnabled: 0, updatedAt: sql`now()` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId));
  }

  async incrementScheduleFailures(tenantId: string): Promise<number> {
    await this.db
      .update(creditAutoTopupSettings)
      .set({
        scheduleConsecutiveFailures: sql`${creditAutoTopupSettings.scheduleConsecutiveFailures} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId));
    const row = await this.getByTenant(tenantId);
    return row?.scheduleConsecutiveFailures ?? 0;
  }

  async resetScheduleFailures(tenantId: string): Promise<void> {
    await this.db
      .update(creditAutoTopupSettings)
      .set({ scheduleConsecutiveFailures: 0, updatedAt: sql`now()` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId));
  }

  async disableSchedule(tenantId: string): Promise<void> {
    await this.db
      .update(creditAutoTopupSettings)
      .set({ scheduleEnabled: 0, updatedAt: sql`now()` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId));
  }

  async advanceScheduleNextAt(tenantId: string): Promise<void> {
    const settings = await this.getByTenant(tenantId);
    if (!settings?.scheduleNextAt) return;

    const currentNext = new Date(settings.scheduleNextAt);
    const newNext = new Date(currentNext.getTime() + settings.scheduleIntervalHours * 60 * 60 * 1000);

    await this.db
      .update(creditAutoTopupSettings)
      .set({ scheduleNextAt: newNext.toISOString(), updatedAt: sql`now()` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId));
  }

  async listDueScheduled(now: string): Promise<AutoTopupSettings[]> {
    const rows = await this.db
      .select()
      .from(creditAutoTopupSettings)
      .where(and(eq(creditAutoTopupSettings.scheduleEnabled, 1), lte(creditAutoTopupSettings.scheduleNextAt, now)));
    return rows.map(mapRow);
  }
}

function mapRow(row: typeof creditAutoTopupSettings.$inferSelect): AutoTopupSettings {
  return {
    tenantId: row.tenantId,
    usageEnabled: row.usageEnabled === 1,
    usageThresholdCredits: row.usageThresholdCredits,
    usageTopupCredits: row.usageTopupCredits,
    usageConsecutiveFailures: row.usageConsecutiveFailures,
    usageChargeInFlight: row.usageChargeInFlight === 1,
    scheduleEnabled: row.scheduleEnabled === 1,
    scheduleAmountCredits: row.scheduleAmountCredits,
    scheduleIntervalHours: row.scheduleIntervalHours,
    scheduleNextAt: row.scheduleNextAt,
    scheduleConsecutiveFailures: row.scheduleConsecutiveFailures,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
