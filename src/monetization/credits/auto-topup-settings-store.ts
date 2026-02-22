import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { creditAutoTopupSettings } from "../../db/schema/credit-auto-topup-settings.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface AutoTopupSettings {
  usage_enabled: boolean;
  usage_threshold_cents: number;
  usage_topup_cents: number;
  schedule_enabled: boolean;
  schedule_interval: "daily" | "weekly" | "monthly" | null;
  schedule_amount_cents: number | null;
  schedule_next_at: string | null;
}

export type AutoTopupSettingsUpdate = Partial<AutoTopupSettings>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ALLOWED_TOPUP_AMOUNTS_CENTS = [500, 1000, 2000, 5000, 10000, 20000, 50000] as const;
export const ALLOWED_THRESHOLD_CENTS = [200, 500, 1000] as const;
export const ALLOWED_SCHEDULE_INTERVALS = ["daily", "weekly", "monthly"] as const;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IAutoTopupSettingsStore {
  get(tenantId: string): AutoTopupSettings;
  upsert(tenantId: string, update: AutoTopupSettingsUpdate): void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: AutoTopupSettings = {
  usage_enabled: false,
  usage_threshold_cents: 500,
  usage_topup_cents: 2000,
  schedule_enabled: false,
  schedule_interval: null,
  schedule_amount_cents: null,
  schedule_next_at: null,
};

// ---------------------------------------------------------------------------
// Drizzle Implementation
// ---------------------------------------------------------------------------

type SettingsRow = typeof creditAutoTopupSettings.$inferInsert;

export class DrizzleAutoTopupSettingsStore implements IAutoTopupSettingsStore {
  constructor(private readonly db: DrizzleDb) {}

  get(tenantId: string): AutoTopupSettings {
    const row = this.db
      .select()
      .from(creditAutoTopupSettings)
      .where(eq(creditAutoTopupSettings.tenantId, tenantId))
      .get();

    if (!row) return { ...DEFAULTS };

    return {
      usage_enabled: row.usageEnabled === 1,
      usage_threshold_cents: row.usageThresholdCents,
      usage_topup_cents: row.usageTopupCents,
      schedule_enabled: row.scheduleEnabled === 1,
      schedule_interval: row.scheduleInterval as AutoTopupSettings["schedule_interval"],
      schedule_amount_cents: row.scheduleAmountCents,
      schedule_next_at: row.scheduleNextAt,
    };
  }

  upsert(tenantId: string, update: AutoTopupSettingsUpdate): void {
    const values: Partial<SettingsRow> = { tenantId };

    if (update.usage_enabled !== undefined) values.usageEnabled = update.usage_enabled ? 1 : 0;
    if (update.usage_threshold_cents !== undefined) values.usageThresholdCents = update.usage_threshold_cents;
    if (update.usage_topup_cents !== undefined) values.usageTopupCents = update.usage_topup_cents;
    if (update.schedule_enabled !== undefined) values.scheduleEnabled = update.schedule_enabled ? 1 : 0;
    if (update.schedule_interval !== undefined) values.scheduleInterval = update.schedule_interval;
    if (update.schedule_amount_cents !== undefined) values.scheduleAmountCents = update.schedule_amount_cents;
    if (update.schedule_next_at !== undefined) values.scheduleNextAt = update.schedule_next_at;

    const existing = this.db
      .select()
      .from(creditAutoTopupSettings)
      .where(eq(creditAutoTopupSettings.tenantId, tenantId))
      .get();

    if (existing) {
      this.db.update(creditAutoTopupSettings).set(values).where(eq(creditAutoTopupSettings.tenantId, tenantId)).run();
    } else {
      const insertValues: SettingsRow = {
        tenantId,
        usageEnabled: DEFAULTS.usage_enabled ? 1 : 0,
        usageThresholdCents: DEFAULTS.usage_threshold_cents,
        usageTopupCents: DEFAULTS.usage_topup_cents,
        scheduleEnabled: DEFAULTS.schedule_enabled ? 1 : 0,
        scheduleInterval: DEFAULTS.schedule_interval,
        scheduleAmountCents: DEFAULTS.schedule_amount_cents,
        scheduleNextAt: DEFAULTS.schedule_next_at,
        ...values,
      };
      this.db.insert(creditAutoTopupSettings).values(insertValues).run();
    }
  }
}

/** @deprecated Use DrizzleAutoTopupSettingsStore directly. */
export { DrizzleAutoTopupSettingsStore as AutoTopupSettingsStore };

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
