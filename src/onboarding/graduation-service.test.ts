import { describe, expect, it, vi } from "vitest";
import type { IBotInstanceRepository } from "../fleet/bot-instance-repository.js";
import type { ISessionUsageRepository } from "../inference/session-usage-repository.js";
import type { IOnboardingSessionRepository, OnboardingSession } from "./drizzle-onboarding-session-repository.js";

function makeSession(overrides: Partial<OnboardingSession> = {}): OnboardingSession {
  return {
    id: "sess-1",
    userId: "user-1",
    anonymousId: null,
    woprSessionName: "onboarding-sess-1",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    graduatedAt: null,
    graduationPath: null,
    totalPlatformCostUsd: null,
    ...overrides,
  };
}

describe("OnboardingSession graduation fields", () => {
  it("session includes graduation fields defaulting to null", () => {
    const session = makeSession();
    expect(session.graduatedAt).toBeNull();
    expect(session.graduationPath).toBeNull();
    expect(session.totalPlatformCostUsd).toBeNull();
  });

  it("graduated session has all graduation fields populated", () => {
    const session = makeSession({
      graduatedAt: Date.now(),
      graduationPath: "byok",
      totalPlatformCostUsd: "0.0823",
    });
    expect(session.graduatedAt).toBeGreaterThan(0);
    expect(session.graduationPath).toBe("byok");
    expect(session.totalPlatformCostUsd).toBe("0.0823");
  });
});

function mockSessionRepo(session: OnboardingSession | null): IOnboardingSessionRepository {
  return {
    getById: vi.fn(async () => session),
    getByUserId: vi.fn(async () => session),
    getByAnonymousId: vi.fn(async () => null),
    getActiveByAnonymousId: vi.fn(async () => null),
    create: vi.fn(),
    upgradeAnonymousToUser: vi.fn(async () => null),
    setStatus: vi.fn(),
    graduate: vi.fn(async (_id: string, path: "byok" | "hosted", cost: string) =>
      session
        ? {
            ...session,
            graduatedAt: Date.now(),
            graduationPath: path,
            totalPlatformCostUsd: cost,
            status: "graduated" as const,
          }
        : null,
    ),
    getGraduatedByUserId: vi.fn(async () => null),
  };
}

function mockBotInstanceRepo(hasBots: boolean): IBotInstanceRepository {
  return {
    getById: vi.fn(async () => null),
    listByNode: vi.fn(async () => []),
    listByTenant: vi.fn(async () =>
      hasBots
        ? [
            {
              id: "bot-1",
              tenantId: "user-1",
              name: "My Bot",
              nodeId: null,
              billingState: "active" as const,
              suspendedAt: null,
              destroyAfter: null,
              createdAt: "",
              updatedAt: "",
              createdByUserId: null,
            },
          ]
        : [],
    ),
    create: vi.fn(),
    reassign: vi.fn(),
    setBillingState: vi.fn(),
    getResourceTier: vi.fn(async () => null),
    setResourceTier: vi.fn(),
  };
}

function mockUsageRepo(totalCost: number): ISessionUsageRepository {
  return {
    insert: vi.fn(),
    findBySessionId: vi.fn(async () => []),
    sumCostByUser: vi.fn(async () => 0),
    sumCostBySession: vi.fn(async () => totalCost),
    aggregateByDay: vi.fn(async () => []),
    aggregateByPage: vi.fn(async () => []),
    cacheHitRate: vi.fn(async () => 0),
  };
}

// GraduationService tests — import after repo interface is defined
describe("GraduationService", () => {
  it("graduates via BYOK when session exists, user has bot, and not already graduated", async () => {
    const { GraduationService } = await import("./graduation-service.js");
    const session = makeSession({ userId: "user-1" });
    const sessionRepo = mockSessionRepo(session);
    const botRepo = mockBotInstanceRepo(true);
    const usageRepo = mockUsageRepo(0.0823);

    const service = new GraduationService(sessionRepo, botRepo, usageRepo);
    const result = await service.graduate("sess-1", "byok");

    expect(result.graduated).toBe(true);
    expect(result.path).toBe("byok");
    expect(result.totalPlatformCostUsd).toBe("0.0823");
    expect(sessionRepo.graduate).toHaveBeenCalledWith("sess-1", "byok", "0.0823");
  });

  it("rejects graduation for anonymous sessions", async () => {
    const { GraduationService } = await import("./graduation-service.js");
    const session = makeSession({ userId: null, anonymousId: "anon-1" });
    const sessionRepo = mockSessionRepo(session);
    const botRepo = mockBotInstanceRepo(true);
    const usageRepo = mockUsageRepo(0);

    const service = new GraduationService(sessionRepo, botRepo, usageRepo);
    await expect(service.graduate("sess-1", "byok")).rejects.toThrow("authenticated user");
  });

  it("rejects graduation when no bot instance exists", async () => {
    const { GraduationService } = await import("./graduation-service.js");
    const session = makeSession({ userId: "user-1" });
    const sessionRepo = mockSessionRepo(session);
    const botRepo = mockBotInstanceRepo(false);
    const usageRepo = mockUsageRepo(0);

    const service = new GraduationService(sessionRepo, botRepo, usageRepo);
    await expect(service.graduate("sess-1", "byok")).rejects.toThrow("bot instance");
  });

  it("rejects graduation when session already graduated", async () => {
    const { GraduationService } = await import("./graduation-service.js");
    const session = makeSession({ userId: "user-1", graduatedAt: Date.now(), graduationPath: "byok" });
    const sessionRepo = mockSessionRepo(session);
    (sessionRepo.graduate as ReturnType<typeof vi.fn>).mockResolvedValue(null); // WHERE graduated_at IS NULL → no rows
    const botRepo = mockBotInstanceRepo(true);
    const usageRepo = mockUsageRepo(0.05);

    const service = new GraduationService(sessionRepo, botRepo, usageRepo);
    await expect(service.graduate("sess-1", "hosted")).rejects.toThrow("already graduated");
  });

  it("isGraduated returns true for graduated session", async () => {
    const { GraduationService } = await import("./graduation-service.js");
    const session = makeSession({ userId: "user-1", graduatedAt: Date.now(), graduationPath: "byok" });
    const sessionRepo = mockSessionRepo(session);
    const botRepo = mockBotInstanceRepo(true);
    const usageRepo = mockUsageRepo(0);

    const service = new GraduationService(sessionRepo, botRepo, usageRepo);
    const result = await service.isGraduated("sess-1");
    expect(result).toBe(true);
  });

  it("isGraduated returns false for non-graduated session", async () => {
    const { GraduationService } = await import("./graduation-service.js");
    const session = makeSession({ userId: "user-1" });
    const sessionRepo = mockSessionRepo(session);
    const botRepo = mockBotInstanceRepo(true);
    const usageRepo = mockUsageRepo(0);

    const service = new GraduationService(sessionRepo, botRepo, usageRepo);
    const result = await service.isGraduated("sess-1");
    expect(result).toBe(false);
  });
});
