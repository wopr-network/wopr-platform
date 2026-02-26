import { randomUUID } from "node:crypto";
import type { OnboardingConfig } from "./config.js";
import type { IDaemonManager } from "./daemon-manager.js";
import type { IOnboardingSessionRepository, OnboardingSession } from "./drizzle-onboarding-session-repository.js";
import type { ConversationEntry, IWoprClient } from "./wopr-client.js";

export class OnboardingService {
  constructor(
    private readonly repo: IOnboardingSessionRepository,
    private readonly client: IWoprClient,
    private readonly config: OnboardingConfig,
    private readonly daemon: IDaemonManager,
  ) {}

  async createSession(opts: { userId?: string; anonymousId?: string }): Promise<OnboardingSession> {
    // Return existing session if one already exists for this user/anon
    if (opts.userId) {
      const existing = await this.repo.getByUserId(opts.userId);
      if (existing && existing.status === "active") {
        return existing;
      }
    }
    if (opts.anonymousId) {
      const existing = await this.repo.getByAnonymousId(opts.anonymousId);
      if (existing && existing.status === "active") {
        return existing;
      }
    }

    const id = randomUUID();
    const woprSessionName = `onboarding-${id}`;

    if (this.daemon.isReady()) {
      await this.client.createSession(
        woprSessionName,
        "You are a helpful onboarding assistant for WOPR, a self-hosted AI chat platform.",
      );
    }

    return this.repo.create({
      id,
      userId: opts.userId ?? null,
      anonymousId: opts.anonymousId ?? null,
      woprSessionName,
      status: "active",
    });
  }

  async getHistory(sessionId: string, limit = 50): Promise<ConversationEntry[]> {
    const session = await this.repo.getById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!this.daemon.isReady()) {
      return [];
    }
    return this.client.getSessionHistory(session.woprSessionName, limit);
  }

  async inject(sessionId: string, message: string, opts: { from?: string } = {}): Promise<string> {
    const session = await this.repo.getById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status !== "active") {
      throw new Error(`Session ${sessionId} is not active (status: ${session.status})`);
    }

    const remaining = this.config.budgetCapCents - session.budgetUsedCents;
    if (remaining <= 0) {
      throw new Error(`Session ${sessionId} has exceeded its budget cap`);
    }

    if (!this.daemon.isReady()) {
      throw new Error("WOPR daemon is not ready");
    }

    const response = await this.client.inject(session.woprSessionName, message, { from: opts.from });
    await this.repo.updateBudgetUsed(sessionId, session.budgetUsedCents + 1);
    return response;
  }

  async upgradeAnonymousToUser(anonymousId: string, userId: string): Promise<OnboardingSession | null> {
    return this.repo.upgradeAnonymousToUser(anonymousId, userId);
  }

  /**
   * Attempt to hand off an anonymous onboarding session to an authenticated user.
   * Returns the upgraded session, or null if handoff was skipped.
   *
   * Skips if: no active anonymous session, session is stale (>24h), or user
   * already has an active session.
   */
  async handoff(anonymousId: string, userId: string): Promise<OnboardingSession | null> {
    const anonSession = await this.repo.getActiveByAnonymousId(anonymousId);
    if (!anonSession) return null;

    // If user already has an active session, mark anon as transferred but don't merge
    const existingUserSession = await this.repo.getByUserId(userId);
    if (existingUserSession && existingUserSession.status === "active") {
      await this.repo.setStatus(anonSession.id, "transferred");
      return null;
    }

    return this.repo.upgradeAnonymousToUser(anonymousId, userId);
  }
}
