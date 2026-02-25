import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IDaemonManager } from "../../src/onboarding/daemon-manager.js";
import type { OnboardingConfig } from "../../src/onboarding/config.js";
import type { IWoprClient } from "../../src/onboarding/wopr-client.js";
import type { IOnboardingSessionRepository, OnboardingSession } from "../../src/onboarding/onboarding-session-repository.js";
import { OnboardingService } from "../../src/onboarding/onboarding-service.js";

function makeSession(overrides: Partial<OnboardingSession> = {}): OnboardingSession {
  return {
    id: "s1",
    userId: "u1",
    anonymousId: null,
    woprSessionName: "onboarding-s1",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    budgetUsedCents: 0,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<IOnboardingSessionRepository> = {}): IOnboardingSessionRepository {
  return {
    getById: vi.fn().mockReturnValue(null),
    getByUserId: vi.fn().mockReturnValue(null),
    getByAnonymousId: vi.fn().mockReturnValue(null),
    create: vi.fn().mockImplementation((d) => makeSession({ ...d, createdAt: Date.now(), updatedAt: Date.now(), budgetUsedCents: 0 })),
    upgradeAnonymousToUser: vi.fn().mockReturnValue(null),
    updateBudgetUsed: vi.fn(),
    setStatus: vi.fn(),
    ...overrides,
  };
}

function makeClient(overrides: Partial<IWoprClient> = {}): IWoprClient {
  return {
    createSession: vi.fn().mockResolvedValue(undefined),
    getSessionHistory: vi.fn().mockResolvedValue([]),
    inject: vi.fn().mockResolvedValue("response"),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeDaemon(ready = true): IDaemonManager {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(ready),
  };
}

const defaultConfig: OnboardingConfig = {
  woprPort: 3847,
  llmProvider: "anthropic",
  llmModel: "claude-sonnet-4-20250514",
  budgetCapCents: 100,
  woprDataDir: "/data/onboarding",
  enabled: true,
};

describe("OnboardingService", () => {
  let repo: IOnboardingSessionRepository;
  let client: IWoprClient;
  let daemon: IDaemonManager;
  let service: OnboardingService;

  beforeEach(() => {
    repo = makeRepo();
    client = makeClient();
    daemon = makeDaemon();
    service = new OnboardingService(repo, client, defaultConfig, daemon);
  });

  describe("createSession", () => {
    it("creates a new session for a user", async () => {
      const session = await service.createSession({ userId: "u1" });
      expect(repo.create).toHaveBeenCalled();
      expect(client.createSession).toHaveBeenCalled();
      expect(session.userId).toBe("u1");
    });

    it("returns existing active session for userId", async () => {
      const existing = makeSession();
      (repo.getByUserId as ReturnType<typeof vi.fn>).mockReturnValue(existing);
      const session = await service.createSession({ userId: "u1" });
      expect(repo.create).not.toHaveBeenCalled();
      expect(session.id).toBe("s1");
    });

    it("creates session for anonymous user", async () => {
      const session = await service.createSession({ anonymousId: "anon-1" });
      expect(repo.create).toHaveBeenCalled();
      expect(session.anonymousId).toBe("anon-1");
    });

    it("returns existing active session for anonymousId", async () => {
      const existing = makeSession({ userId: null, anonymousId: "anon-1" });
      (repo.getByAnonymousId as ReturnType<typeof vi.fn>).mockReturnValue(existing);
      const session = await service.createSession({ anonymousId: "anon-1" });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it("does not call client.createSession if daemon not ready", async () => {
      daemon = makeDaemon(false);
      service = new OnboardingService(repo, client, defaultConfig, daemon);
      await service.createSession({ userId: "u1" });
      expect(client.createSession).not.toHaveBeenCalled();
    });
  });

  describe("getHistory", () => {
    it("returns history from client", async () => {
      const existing = makeSession();
      (repo.getById as ReturnType<typeof vi.fn>).mockReturnValue(existing);
      (client.getSessionHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ts: 1, from: "user", content: "hi", type: "text" },
      ]);
      const history = await service.getHistory("s1");
      expect(history).toHaveLength(1);
    });

    it("throws if session not found", async () => {
      await expect(service.getHistory("missing")).rejects.toThrow("not found");
    });

    it("returns empty array if daemon not ready", async () => {
      daemon = makeDaemon(false);
      service = new OnboardingService(repo, client, defaultConfig, daemon);
      (repo.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
      const history = await service.getHistory("s1");
      expect(history).toEqual([]);
    });
  });

  describe("inject", () => {
    it("calls client.inject and returns response", async () => {
      (repo.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
      const result = await service.inject("s1", "Hello");
      expect(result).toBe("response");
    });

    it("throws if session not found", async () => {
      await expect(service.inject("missing", "hi")).rejects.toThrow("not found");
    });

    it("throws if session is not active", async () => {
      (repo.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeSession({ status: "expired" }));
      await expect(service.inject("s1", "hi")).rejects.toThrow("not active");
    });

    it("throws if budget exceeded", async () => {
      (repo.getById as ReturnType<typeof vi.fn>).mockReturnValue(
        makeSession({ budgetUsedCents: 100 }),
      );
      await expect(service.inject("s1", "hi")).rejects.toThrow("budget cap");
    });

    it("throws if daemon not ready", async () => {
      daemon = makeDaemon(false);
      service = new OnboardingService(repo, client, defaultConfig, daemon);
      (repo.getById as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
      await expect(service.inject("s1", "hi")).rejects.toThrow("not ready");
    });
  });

  describe("upgradeAnonymousToUser", () => {
    it("delegates to repository", () => {
      const upgraded = makeSession({ userId: "u2", anonymousId: "anon-1" });
      (repo.upgradeAnonymousToUser as ReturnType<typeof vi.fn>).mockReturnValue(upgraded);
      const result = service.upgradeAnonymousToUser("anon-1", "u2");
      expect(result).not.toBeNull();
      expect(result!.userId).toBe("u2");
    });
  });
});
