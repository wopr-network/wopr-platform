import { randomUUID } from "node:crypto";

export interface SSEWriter {
  write(chunk: string): void;
  close(): void;
}

/**
 * In-memory registry of active SSE connections.
 * Maps streamId -> writer, with a reverse index from sessionId -> streamIds.
 */
export class ChatStreamRegistry {
  private writers = new Map<string, SSEWriter>();
  private sessionIndex = new Map<string, Set<string>>();

  /** Register a new SSE writer. Returns the generated streamId. */
  register(sessionId: string, writer: SSEWriter): string {
    const streamId = randomUUID();
    this.writers.set(streamId, writer);

    let set = this.sessionIndex.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionIndex.set(sessionId, set);
    }
    set.add(streamId);

    return streamId;
  }

  /** Get a writer by streamId. */
  get(streamId: string): SSEWriter | undefined {
    return this.writers.get(streamId);
  }

  /** Remove a writer (e.g., on disconnect). */
  remove(streamId: string): void {
    this.writers.delete(streamId);
    for (const [sessionId, set] of this.sessionIndex) {
      set.delete(streamId);
      if (set.size === 0) this.sessionIndex.delete(sessionId);
    }
  }

  /** List all active streamIds for a session. */
  listBySession(sessionId: string): string[] {
    const set = this.sessionIndex.get(sessionId);
    return set ? [...set] : [];
  }

  private sessionOwners = new Map<string, string>();

  /**
   * Atomically claim the session for userId if unclaimed, then verify ownership.
   * Returns true if this userId is (or just became) the owner.
   * Replaces the separate setOwner + isOwner pattern to eliminate the TOCTOU race.
   */
  claimOrVerifyOwner(sessionId: string, userId: string): boolean {
    if (!this.sessionOwners.has(sessionId)) {
      this.sessionOwners.set(sessionId, userId);
    }
    return this.sessionOwners.get(sessionId) === userId;
  }

  /** Remove ownership record for a session (call on stream teardown / session destroy). */
  clearOwner(sessionId: string): void {
    this.sessionOwners.delete(sessionId);
  }

  /** Get the owner of a session, or undefined if not yet claimed. */
  getOwner(sessionId: string): string | undefined {
    return this.sessionOwners.get(sessionId);
  }
}
