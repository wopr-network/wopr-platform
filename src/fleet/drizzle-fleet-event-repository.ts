import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { fleetEvents } from "../db/schema/index.js";
import type { IFleetEventRepository } from "./fleet-event-repository.js";

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
}
