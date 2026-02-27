import type { ISetupSessionRepository, SetupSession } from "./setup-session-repository.js";

export interface RollbackResult {
  sessionId: string;
  configKeysRemoved: string[];
  dependenciesRemoved: string[];
}

export interface ResumeCheckResult {
  hasStaleSession: boolean;
  session?: SetupSession;
}

const AUTO_ROLLBACK_THRESHOLD = 3;

export class SetupService {
  constructor(private readonly repo: ISetupSessionRepository) {}

  /**
   * Roll back a setup session — clears collected config and installed deps,
   * marks the session as rolled_back. Idempotent: safe to call on an
   * already-rolled-back session.
   */
  async rollback(setupSessionId: string): Promise<RollbackResult> {
    const session = await this.repo.findById(setupSessionId);
    if (!session) throw new Error(`SetupSession not found: ${setupSessionId}`);

    if (session.status === "rolled_back") {
      return { sessionId: setupSessionId, configKeysRemoved: [], dependenciesRemoved: [] };
    }

    const configKeysRemoved = session.collected
      ? Object.keys(JSON.parse(session.collected) as Record<string, unknown>)
      : [];
    const dependenciesRemoved = session.dependenciesInstalled
      ? (JSON.parse(session.dependenciesInstalled) as string[])
      : [];

    await this.repo.update(setupSessionId, {
      collected: null,
      dependenciesInstalled: null,
    });
    await this.repo.markRolledBack(setupSessionId);

    return { sessionId: setupSessionId, configKeysRemoved, dependenciesRemoved };
  }

  /**
   * Record a setup error. Returns the new consecutive error count.
   * If the count reaches AUTO_ROLLBACK_THRESHOLD (3), auto-rolls back.
   */
  async recordError(setupSessionId: string): Promise<number> {
    const newCount = await this.repo.incrementErrorCount(setupSessionId);
    if (newCount >= AUTO_ROLLBACK_THRESHOLD) {
      await this.rollback(setupSessionId);
    }
    return newCount;
  }

  /**
   * Record a successful operation (e.g. saveConfig). Resets error count to 0.
   */
  async recordSuccess(setupSessionId: string): Promise<void> {
    await this.repo.resetErrorCount(setupSessionId);
  }

  /**
   * Find and roll back all sessions stale beyond `olderThanMs`.
   * Called by the 15-minute cleanup interval.
   */
  async cleanupStaleSessions(olderThanMs: number): Promise<RollbackResult[]> {
    const stale = await this.repo.findStale(olderThanMs);
    const results: RollbackResult[] = [];
    for (const session of stale) {
      const result = await this.rollback(session.id);
      results.push(result);
    }
    return results;
  }

  /**
   * Check if there's an existing in-progress session for this chat session.
   * Used on return visit to offer resume or restart.
   */
  async checkForResumable(sessionId: string): Promise<ResumeCheckResult> {
    const session = await this.repo.findBySessionId(sessionId);
    if (session) {
      return { hasStaleSession: true, session };
    }
    return { hasStaleSession: false };
  }
}
