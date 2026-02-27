import { describe, expect, it, vi } from "vitest";
import type { OnboardingConfig } from "./config.js";
import type { IDaemonManager } from "./daemon-manager.js";
import type { IOnboardingScriptRepository } from "./drizzle-onboarding-script-repository.js";
import type { IOnboardingSessionRepository } from "./drizzle-onboarding-session-repository.js";
import { OnboardingService } from "./onboarding-service.js";
import type { IWoprClient } from "./wopr-client.js";

function mockConfig(): OnboardingConfig {
  return {
    woprPort: 3847,
    llmProvider: "anthropic",
    llmModel: "test",
    budgetCapCents: 100,
    woprDataDir: "/tmp",
    enabled: true,
  };
}

function mockSessionRepo(): IOnboardingSessionRepository {
  return {
    getById: vi.fn().mockResolvedValue(null),
    getByUserId: vi.fn().mockResolvedValue(null),
    getByAnonymousId: vi.fn().mockResolvedValue(null),
    getActiveByAnonymousId: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async (data) => ({
      ...data,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      budgetUsedCents: 0,
    })),
    upgradeAnonymousToUser: vi.fn().mockResolvedValue(null),
    updateBudgetUsed: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    graduate: vi.fn().mockResolvedValue(null),
    getGraduatedByUserId: vi.fn().mockResolvedValue(null),
  };
}

function mockWoprClient(): IWoprClient {
  return {
    createSession: vi.fn().mockResolvedValue(undefined),
    getSessionHistory: vi.fn().mockResolvedValue([]),
    inject: vi.fn().mockResolvedValue("response"),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

function mockDaemon(): IDaemonManager {
  return { start: vi.fn(), stop: vi.fn(), isReady: vi.fn().mockReturnValue(true) };
}

function mockScriptRepo(content = "# Test Script"): IOnboardingScriptRepository {
  return {
    findCurrent: vi.fn().mockResolvedValue({ id: "s1", content, version: 1, updatedAt: Date.now(), updatedBy: null }),
    findHistory: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue({ id: "s2", content, version: 2, updatedAt: Date.now(), updatedBy: null }),
  };
}

describe("OnboardingService", () => {
  it("createSession passes DB script content to WoprClient", async () => {
    const client = mockWoprClient();
    const scriptRepo = mockScriptRepo("# WOPR Onboarding Script");
    const service = new OnboardingService(mockSessionRepo(), client, mockConfig(), mockDaemon(), undefined, scriptRepo);

    await service.createSession({ anonymousId: "anon-1" });

    expect(client.createSession).toHaveBeenCalledWith(
      expect.stringContaining("onboarding-"),
      "# WOPR Onboarding Script",
    );
  });

  it("createSession skips WoprClient when daemon is not ready", async () => {
    const client = mockWoprClient();
    const daemon: IDaemonManager = { start: vi.fn(), stop: vi.fn(), isReady: vi.fn().mockReturnValue(false) };
    const service = new OnboardingService(mockSessionRepo(), client, mockConfig(), daemon, undefined, mockScriptRepo());

    await service.createSession({ anonymousId: "anon-3" });

    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("createSession falls back to default prompt when no script in DB", async () => {
    const client = mockWoprClient();
    const scriptRepo: IOnboardingScriptRepository = {
      findCurrent: vi.fn().mockResolvedValue(undefined),
      findHistory: vi.fn().mockResolvedValue([]),
      insert: vi.fn(),
    };
    const service = new OnboardingService(mockSessionRepo(), client, mockConfig(), mockDaemon(), undefined, scriptRepo);

    await service.createSession({ anonymousId: "anon-2" });

    expect(client.createSession).toHaveBeenCalledWith(
      expect.stringContaining("onboarding-"),
      expect.stringContaining("onboarding assistant"),
    );
  });
});
