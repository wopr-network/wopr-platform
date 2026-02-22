import { and, eq, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { webhookSeenEvents } from "../db/schema/index.js";
import type { WebhookSeenEvent } from "./repository-types.js";
import type { IWebhookSeenRepository } from "./webhook-seen-repository.js";

export class DrizzleWebhookSeenRepository implements IWebhookSeenRepository {
  constructor(private readonly db: DrizzleDb) {}

  isDuplicate(eventId: string, source: string): boolean {
    const row = this.db
      .select()
      .from(webhookSeenEvents)
      .where(and(eq(webhookSeenEvents.eventId, eventId), eq(webhookSeenEvents.source, source)))
      .get();
    return row !== undefined;
  }

  markSeen(eventId: string, source: string): WebhookSeenEvent {
    const seenAt = Date.now();
    this.db.insert(webhookSeenEvents).values({ eventId, source, seenAt }).onConflictDoNothing().run();
    return { eventId, source, seenAt };
  }

  purgeExpired(ttlMs: number): number {
    const cutoff = Date.now() - ttlMs;
    const result = this.db.delete(webhookSeenEvents).where(lt(webhookSeenEvents.seenAt, cutoff)).run();
    return result.changes;
  }
}
