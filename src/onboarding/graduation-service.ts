import type { IBotInstanceRepository } from "../fleet/bot-instance-repository.js";
import type { ISessionUsageRepository } from "../inference/session-usage-repository.js";
import type { IOnboardingSessionRepository } from "./drizzle-onboarding-session-repository.js";

export type GraduationPath = "byok" | "hosted";

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
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (!session.userId) throw new Error("Graduation requires an authenticated user");

    const bots = await this.botRepo.listByTenant(session.userId);
    if (bots.length === 0) {
      throw new Error("Cannot graduate: no bot instance exists for this user. Create a bot first.");
    }

    const totalCost = await this.usageRepo.sumCostBySession(sessionId);
    const totalPlatformCostUsd = totalCost.toFixed(4);

    const graduated = await this.sessionRepo.graduate(sessionId, path, totalPlatformCostUsd);
    if (!graduated) {
      throw new Error("Session already graduated");
    }

    return {
      graduated: true,
      path,
      totalPlatformCostUsd,
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
