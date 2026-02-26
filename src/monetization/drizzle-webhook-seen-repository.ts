import { and, eq, lt } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { webhookSeenEvents } from "../db/schema/index.js";
import type { WebhookSeenEvent } from "./repository-types.js";
import type { IWebhookSeenRepository } from "./webhook-seen-repository.js";

export class DrizzleWebhookSeenRepository implements IWebhookSeenRepository {
  constructor(private readonly db: DrizzleDb) {}

  async isDuplicate(eventId: string, source: string): Promise<boolean> {
    const row = (
      await this.db
        .select()
        .from(webhookSeenEvents)
        .where(and(eq(webhookSeenEvents.eventId, eventId), eq(webhookSeenEvents.source, source)))
    )[0];
    return row !== undefined;
  }

  async markSeen(eventId: string, source: string): Promise<WebhookSeenEvent> {
    const seenAt = Date.now();
    await this.db.insert(webhookSeenEvents).values({ eventId, source, seenAt }).onConflictDoNothing();
    return { eventId, source, seenAt };
  }

  async purgeExpired(ttlMs: number): Promise<number> {
    const cutoff = Date.now() - ttlMs;
    const result = await this.db
      .delete(webhookSeenEvents)
      .where(lt(webhookSeenEvents.seenAt, cutoff))
      .returning({ id: webhookSeenEvents.eventId });
    return result.length;
  }
}
