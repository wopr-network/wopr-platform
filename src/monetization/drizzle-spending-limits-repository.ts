import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { tenantSpendingLimits } from "../db/schema/spending-limits.js";

export interface SpendingLimitsData {
  global: { alertAt: number | null; hardCap: number | null };
  perCapability: Record<string, { alertAt: number | null; hardCap: number | null }>;
}

const DEFAULT_LIMITS: SpendingLimitsData = {
  global: { alertAt: null, hardCap: null },
  perCapability: {},
};

export interface ISpendingLimitsRepository {
  get(tenantId: string): Promise<SpendingLimitsData>;
  upsert(tenantId: string, data: SpendingLimitsData): Promise<void>;
}

export class DrizzleSpendingLimitsRepository implements ISpendingLimitsRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(tenantId: string): Promise<SpendingLimitsData> {
    const row = (
      await this.db.select().from(tenantSpendingLimits).where(eq(tenantSpendingLimits.tenantId, tenantId))
    )[0];

    if (!row) return { ...DEFAULT_LIMITS, global: { ...DEFAULT_LIMITS.global } };

    let perCapability: Record<string, { alertAt: number | null; hardCap: number | null }> = {};
    if (row.perCapabilityJson) {
      try {
        perCapability = JSON.parse(row.perCapabilityJson);
      } catch {
        perCapability = {};
      }
    }

    return {
      global: { alertAt: row.globalAlertAt, hardCap: row.globalHardCap },
      perCapability,
    };
  }

  async upsert(tenantId: string, data: SpendingLimitsData): Promise<void> {
    const now = Date.now();
    await this.db
      .insert(tenantSpendingLimits)
      .values({
        tenantId,
        globalAlertAt: data.global.alertAt,
        globalHardCap: data.global.hardCap,
        perCapabilityJson: JSON.stringify(data.perCapability),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tenantSpendingLimits.tenantId,
        set: {
          globalAlertAt: data.global.alertAt,
          globalHardCap: data.global.hardCap,
          perCapabilityJson: JSON.stringify(data.perCapability),
          updatedAt: now,
        },
      });
  }
}
