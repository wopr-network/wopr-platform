import { and, eq, lte, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditAutoTopupSettings } from "../../db/schema/credit-auto-topup-settings.js";
import { Credit } from "../credit.js";

export const ALLOWED_TOPUP_AMOUNTS = [500, 1000, 2000, 5000, 10000, 20000, 50000] as const;
export const ALLOWED_THRESHOLDS = [200, 500, 1000] as const;
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
  usageThreshold: Credit;
  usageTopup: Credit;
  usageConsecutiveFailures: number;
  usageChargeInFlight: boolean;
  scheduleEnabled: boolean;
  scheduleAmount: Credit;
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
  /** Atomically set usage_charge_in_flight = true IFF it is currently false. Returns true if acquired. */
  tryAcquireUsageInFlight(tenantId: string): Promise<boolean>;
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
      values.usageEnabled = settings.usageEnabled;
      updateSet.usageEnabled = values.usageEnabled;
    }
    if (settings.usageThreshold !== undefined) {
      const cents = Math.round(settings.usageThreshold.toCents());
      values.usageThresholdCents = cents;
      updateSet.usageThresholdCents = cents;
    }
    if (settings.usageTopup !== undefined) {
      const cents = Math.round(settings.usageTopup.toCents());
      values.usageTopupCents = cents;
      updateSet.usageTopupCents = cents;
    }
    if (settings.scheduleEnabled !== undefined) {
      values.scheduleEnabled = settings.scheduleEnabled;
      updateSet.scheduleEnabled = values.scheduleEnabled;
    }
    if (settings.scheduleAmount !== undefined) {
      const cents = Math.round(settings.scheduleAmount.toCents());
      values.scheduleAmountCents = cents;
      updateSet.scheduleAmountCents = cents;
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
      .set({ usageChargeInFlight: inFlight, updatedAt: sql`now()` })
      .where(eq(creditAutoTopupSettings.tenantId, tenantId));
  }

  async tryAcquireUsageInFlight(tenantId: string): Promise<boolean> {
    const rows = await this.db
      .update(creditAutoTopupSettings)
      .set({ usageChargeInFlight: true, updatedAt: sql`now()` })
      .where(
        and(eq(creditAutoTopupSettings.tenantId, tenantId), eq(creditAutoTopupSettings.usageChargeInFlight, false)),
      )
      .returning({ tenantId: creditAutoTopupSettings.tenantId });
    return rows.length > 0;
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
      .set({ usageEnabled: false, updatedAt: sql`now()` })
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
      .set({ scheduleEnabled: false, updatedAt: sql`now()` })
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
      .where(and(eq(creditAutoTopupSettings.scheduleEnabled, true), lte(creditAutoTopupSettings.scheduleNextAt, now)));
    return rows.map(mapRow);
  }
}

function mapRow(row: typeof creditAutoTopupSettings.$inferSelect): AutoTopupSettings {
  return {
    tenantId: row.tenantId,
    usageEnabled: row.usageEnabled,
    usageThreshold: Credit.fromCents(row.usageThresholdCents),
    usageTopup: Credit.fromCents(row.usageTopupCents),
    usageConsecutiveFailures: row.usageConsecutiveFailures,
    usageChargeInFlight: row.usageChargeInFlight,
    scheduleEnabled: row.scheduleEnabled,
    scheduleAmount: Credit.fromCents(row.scheduleAmountCents),
    scheduleIntervalHours: row.scheduleIntervalHours,
    scheduleNextAt: row.scheduleNextAt,
    scheduleConsecutiveFailures: row.scheduleConsecutiveFailures,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
