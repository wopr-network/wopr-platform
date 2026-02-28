import type { WebhookSeenEvent } from "./repository-types.js";

export interface IWebhookSeenRepository {
  /** Returns true if the event ID + source combination has already been seen. */
  isDuplicate(eventId: string, source: string): Promise<boolean>;
  /** Mark an event ID + source as seen. */
  markSeen(eventId: string, source: string): Promise<WebhookSeenEvent>;
  /** Delete entries older than ttlMs. Returns count of deleted rows. */
  purgeExpired(ttlMs: number): Promise<number>;
}

/**
 * No-op replay guard that never reports duplicates.
 * Use in tests that don't need deduplication behaviour.
 */
export const noOpReplayGuard: IWebhookSeenRepository = {
  isDuplicate: async () => false,
  markSeen: async (eventId: string, source: string): Promise<WebhookSeenEvent> => ({
    eventId,
    source,
    seenAt: Date.now(),
  }),
  purgeExpired: async () => 0,
};
