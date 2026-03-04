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

  /** Record the owner of a session. First call wins — subsequent calls with different userId are no-ops. */
  setOwner(sessionId: string, userId: string): void {
    if (!this.sessionOwners.has(sessionId)) {
      this.sessionOwners.set(sessionId, userId);
    }
  }

  /** Get the owner of a session, or undefined if not yet claimed. */
  getOwner(sessionId: string): string | undefined {
    return this.sessionOwners.get(sessionId);
  }

  /** Check if userId owns the session. Returns true if session is unclaimed (first user will claim it). */
  isOwner(sessionId: string, userId: string): boolean {
    const owner = this.sessionOwners.get(sessionId);
    return owner === undefined || owner === userId;
  }
}
