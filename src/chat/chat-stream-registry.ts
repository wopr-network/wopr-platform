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
}
