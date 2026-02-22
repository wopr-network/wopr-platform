import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { fleetEvents } from "../db/schema/index.js";
import type { IFleetEventRepository } from "./fleet-event-repository.js";

export class DrizzleFleetEventRepository implements IFleetEventRepository {
  constructor(private readonly db: DrizzleDb) {}

  fireFleetStop(): void {
    this.db.insert(fleetEvents).values({ eventType: "unexpected_stop", fired: 1, createdAt: Date.now() }).run();
  }

  clearFleetStop(): void {
    const now = Date.now();
    this.db
      .update(fleetEvents)
      .set({ fired: 0, clearedAt: now })
      .where(eq(fleetEvents.eventType, "unexpected_stop"))
      .run();
  }

  isFleetStopFired(): boolean {
    const row = this.db.select().from(fleetEvents).where(eq(fleetEvents.eventType, "unexpected_stop")).get();
    return row !== undefined && row.fired === 1;
  }
}
