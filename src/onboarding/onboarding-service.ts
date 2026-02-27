import { randomUUID } from "node:crypto";
import type { BudgetTier } from "../inference/budget-guard.js";
import { checkSessionBudget } from "../inference/budget-guard.js";
import { computeInferenceCost } from "../inference/inference-cost.js";
import type { ISessionUsageRepository } from "../inference/session-usage-repository.js";
import type { OnboardingConfig } from "./config.js";
import type { IDaemonManager } from "./daemon-manager.js";
import type { IOnboardingScriptRepository } from "./drizzle-onboarding-script-repository.js";
import type { IOnboardingSessionRepository, OnboardingSession } from "./drizzle-onboarding-session-repository.js";
import type { ConversationEntry, IWoprClient } from "./wopr-client.js";

export class OnboardingService {
  private static readonly DEFAULT_PROMPT =
    "You are a helpful onboarding assistant for WOPR, a self-hosted AI chat platform.";

  private static readonly DEFAULT_SCRIPT_REPO: IOnboardingScriptRepository = {
    findCurrent: async () => undefined,
    findHistory: async () => [],
    insert: async () => {
      throw new Error("No script repository configured");
    },
  };

  constructor(
    private readonly repo: IOnboardingSessionRepository,
    private readonly client: IWoprClient,
    private readonly config: OnboardingConfig,
    private readonly daemon: IDaemonManager,
    private readonly usageRepo?: ISessionUsageRepository,
    private readonly scriptRepo: IOnboardingScriptRepository = OnboardingService.DEFAULT_SCRIPT_REPO,
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
      const script = await this.scriptRepo.findCurrent();
      const context = script?.content ?? OnboardingService.DEFAULT_PROMPT;
      await this.client.createSession(woprSessionName, context);
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

    // Real USD budget check (when usageRepo is available)
    if (this.usageRepo) {
      const tier: BudgetTier = session.userId ? "free" : "anonymous";
      const budgetCheck = await checkSessionBudget(this.usageRepo, sessionId, tier);
      if (!budgetCheck.allowed) {
        throw new Error(
          session.userId
            ? `Session budget exceeded ($${budgetCheck.capUsd.toFixed(2)} cap). To continue, either add your own API key (Settings > API Keys) or add a payment method (Settings > Billing).`
            : `Session budget exceeded ($${budgetCheck.capUsd.toFixed(2)} cap). Sign up for a free account to continue.`,
        );
      }
    } else {
      // Fallback: cent-based check
      const remaining = this.config.budgetCapCents - session.budgetUsedCents;
      if (remaining <= 0) {
        throw new Error(`Session ${sessionId} has exceeded its budget cap`);
      }
    }

    if (!this.daemon.isReady()) {
      throw new Error("WOPR daemon is not ready");
    }

    const response = await this.client.inject(session.woprSessionName, message, {
      from: opts.from,
    });

    // Record estimated token usage
    if (this.usageRepo) {
      const inputTokensEst = Math.ceil(message.length / 4);
      const outputTokensEst = Math.ceil(response.length / 4);
      const cost = computeInferenceCost({
        model: this.config.llmModel,
        inputTokens: inputTokensEst,
        outputTokens: outputTokensEst,
        cachedTokens: 0,
        cacheWriteTokens: 0,
      });
      await this.usageRepo.insert({
        sessionId,
        userId: session.userId,
        page: null,
        inputTokens: inputTokensEst,
        outputTokens: outputTokensEst,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        model: this.config.llmModel,
        costUsd: cost,
      });
    }

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
