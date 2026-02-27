import type { IBotInstanceRepository } from "../fleet/bot-instance-repository.js";
import type { ISessionUsageRepository } from "../inference/session-usage-repository.js";
import type { IOnboardingSessionRepository } from "./drizzle-onboarding-session-repository.js";

export type GraduationPath = "byok" | "hosted";

export type GraduationErrorCode = "NOT_FOUND" | "ALREADY_GRADUATED" | "NO_BOT_INSTANCE" | "UNAUTHENTICATED";

export class GraduationError extends Error {
  constructor(
    public readonly code: GraduationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GraduationError";
  }
}

export interface GraduationResult {
  graduated: boolean;
  path: GraduationPath;
  totalPlatformCostUsd: string;
  botInstanceId: string;
}

export class GraduationService {
  constructor(
    private readonly sessionRepo: IOnboardingSessionRepository,
    private readonly botRepo: IBotInstanceRepository,
    private readonly usageRepo: ISessionUsageRepository,
  ) {}

  async graduate(sessionId: string, path: GraduationPath): Promise<GraduationResult> {
    const session = await this.sessionRepo.getById(sessionId);
    if (!session) throw new GraduationError("NOT_FOUND", `Session not found: ${sessionId}`);
    if (!session.userId) throw new GraduationError("UNAUTHENTICATED", "Graduation requires an authenticated user");

    const bots = await this.botRepo.listByTenant(session.userId);
    if (bots.length === 0) {
      throw new GraduationError(
        "NO_BOT_INSTANCE",
        "Cannot graduate: no bot instance exists for this user. Create a bot first.",
      );
    }

    const totalCost = await this.usageRepo.sumCostBySession(sessionId);
    const totalPlatformCostUsd = totalCost.toFixed(4);

    const graduated = await this.sessionRepo.graduate(sessionId, path, totalPlatformCostUsd);
    if (!graduated) {
      throw new GraduationError("ALREADY_GRADUATED", "Session already graduated");
    }

    return {
      graduated: true,
      path,
      totalPlatformCostUsd,
      // v1: graduate to the first/earliest-created bot; multi-bot users must explicitly select
      botInstanceId: bots[0].id,
    };
  }

  async isGraduated(sessionId: string): Promise<boolean> {
    const session = await this.sessionRepo.getById(sessionId);
    if (!session) return false;
    return session.graduatedAt !== null;
  }

  async getGraduatedSession(userId: string) {
    return this.sessionRepo.getGraduatedByUserId(userId);
  }
}
