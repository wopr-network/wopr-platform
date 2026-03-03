import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { meterEvents } from "../../db/schema/meter-events.js";
import type { MeterEventRow } from "./types.js";

/** Values needed to insert a single meter event row. */
export interface MeterEventInsert {
  id: string;
  tenant: string;
  cost: number;
  charge: number;
  capability: string;
  provider: string;
  timestamp: number;
  sessionId: string | null;
  duration: number | null;
  usageUnits: number | null;
  usageUnitType: string | null;
  tier: string | null;
  metadata: string | null;
}

export interface IMeterEventRepository {
  /** Check if an event ID already exists in the database. */
  existsById(id: string): Promise<boolean>;
  /** Insert a batch of events in a single transaction. */
  insertBatch(events: MeterEventInsert[]): Promise<void>;
  /** Query persisted events for a tenant, ordered by timestamp desc. */
  queryByTenant(tenant: string, limit: number): Promise<MeterEventRow[]>;
}

export class DrizzleMeterEventRepository implements IMeterEventRepository {
  constructor(private readonly db: DrizzleDb) {}

  async existsById(id: string): Promise<boolean> {
    const row = (await this.db.select({ id: meterEvents.id }).from(meterEvents).where(eq(meterEvents.id, id)))[0];
    return !!row;
  }

  async insertBatch(events: MeterEventInsert[]): Promise<void> {
    if (events.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const e of events) {
        await tx.insert(meterEvents).values({
          id: e.id,
          tenant: e.tenant,
          cost: e.cost,
          charge: e.charge,
          capability: e.capability,
          provider: e.provider,
          timestamp: e.timestamp,
          sessionId: e.sessionId,
          duration: e.duration,
          usageUnits: e.usageUnits,
          usageUnitType: e.usageUnitType,
          tier: e.tier,
          metadata: e.metadata,
        });
      }
    });
  }

  async queryByTenant(tenant: string, limit: number): Promise<MeterEventRow[]> {
    const rows = await this.db
      .select()
      .from(meterEvents)
      .where(eq(meterEvents.tenant, tenant))
      .orderBy(desc(meterEvents.timestamp))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      tenant: r.tenant,
      cost: r.cost,
      charge: r.charge,
      capability: r.capability,
      provider: r.provider,
      timestamp: r.timestamp,
      session_id: r.sessionId,
      duration: r.duration,
      usage_units: r.usageUnits,
      usage_unit_type: r.usageUnitType,
      tier: r.tier,
      metadata: r.metadata,
    }));
  }
}
