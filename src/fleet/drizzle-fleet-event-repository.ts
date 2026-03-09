import { and, desc, eq, gte } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { fleetEventHistory, fleetEvents } from "../db/schema/index.js";
import type {
  FleetEventHistoryFilter,
  FleetEventHistoryRow,
  IFleetEventRepository,
  NewFleetEventHistoryRow,
} from "./fleet-event-repository.js";

export class DrizzleFleetEventRepository implements IFleetEventRepository {
  constructor(private readonly db: DrizzleDb) {}

  async fireFleetStop(): Promise<void> {
    const rows = await this.db.select().from(fleetEvents).where(eq(fleetEvents.eventType, "unexpected_stop"));
    const existing = rows[0];
    if (existing) {
      await this.db
        .update(fleetEvents)
        .set({ fired: true, createdAt: Date.now() })
        .where(eq(fleetEvents.eventType, "unexpected_stop"));
    } else {
      await this.db.insert(fleetEvents).values({ eventType: "unexpected_stop", fired: true, createdAt: Date.now() });
    }
  }

  async clearFleetStop(): Promise<void> {
    const now = Date.now();
    await this.db
      .update(fleetEvents)
      .set({ fired: false, clearedAt: now })
      .where(eq(fleetEvents.eventType, "unexpected_stop"));
  }

  async isFleetStopFired(): Promise<boolean> {
    const rows = await this.db.select().from(fleetEvents).where(eq(fleetEvents.eventType, "unexpected_stop"));
    return rows.length > 0 && rows[0].fired === true;
  }

  async append(event: NewFleetEventHistoryRow): Promise<void> {
    await this.db.insert(fleetEventHistory).values({
      eventType: event.eventType,
      botId: event.botId,
      tenantId: event.tenantId,
      createdAt: event.createdAt,
    });
  }

  async list(filter: FleetEventHistoryFilter): Promise<FleetEventHistoryRow[]> {
    const conditions = [];
    if (filter.botId) conditions.push(eq(fleetEventHistory.botId, filter.botId));
    if (filter.tenantId) conditions.push(eq(fleetEventHistory.tenantId, filter.tenantId));
    if (filter.type) conditions.push(eq(fleetEventHistory.eventType, filter.type));
    if (filter.since) conditions.push(gte(fleetEventHistory.createdAt, filter.since));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = filter.limit ?? 100;

    return this.db
      .select()
      .from(fleetEventHistory)
      .where(where)
      .orderBy(desc(fleetEventHistory.createdAt))
      .limit(limit);
  }
}
