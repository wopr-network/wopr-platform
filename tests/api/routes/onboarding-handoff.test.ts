import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { OnboardingSession } from "../../../src/onboarding/drizzle-onboarding-session-repository.js";

function makeSession(overrides: Partial<OnboardingSession> = {}): OnboardingSession {
  return {
    id: "s1",
    userId: null,
    anonymousId: "anon-1",
    woprSessionName: "onboarding-s1",
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    graduatedAt: null,
    graduationPath: null,
    totalPlatformCostUsd: null,
    ...overrides,
  };
}

describe("onboarding handoff route", () => {
  let app: Hono;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  let mockService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    vi.resetModules();
    mockService = {
      createSession: vi.fn().mockResolvedValue(makeSession()),
      getHistory: vi.fn().mockResolvedValue([]),
      inject: vi.fn().mockResolvedValue(""),
      upgradeAnonymousToUser: vi.fn(),
      handoff: vi.fn().mockReturnValue(makeSession({ userId: "u1" })),
    };
    const { setOnboardingDeps, onboardingRoutes } = await import(
      "../../../src/api/routes/onboarding.js"
    );
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    setOnboardingDeps(mockService as never, {} as never);

    app = new Hono();
    app.use("*", async (c, next) => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      c.set("user" as never, { id: "u1" } as never);
      await next();
    });
    app.route("/api/onboarding", onboardingRoutes);
  });

  describe("POST /session/handoff", () => {
    it("returns 200 with session on successful handoff", async () => {
      const res = await app.request("/api/onboarding/session/handoff", {
        method: "POST",
        headers: { Cookie: "wopr_anon_session=anon-1" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessionId: string; resumed: boolean };
      expect(body.sessionId).toBe("s1");
      expect(body.resumed).toBe(true);
      expect(mockService.handoff).toHaveBeenCalledWith("anon-1", "u1");
    });

    it("clears the anonymous cookie on successful handoff", async () => {
      const res = await app.request("/api/onboarding/session/handoff", {
        method: "POST",
        headers: { Cookie: "wopr_anon_session=anon-1" },
      });
      const setCookieHeader = res.headers.get("set-cookie");
      expect(setCookieHeader).toContain("wopr_anon_session=");
      expect(setCookieHeader).toContain("Max-Age=0");
    });

    it("returns 204 when no anonymous cookie is present", async () => {
      const res = await app.request("/api/onboarding/session/handoff", { method: "POST" });
      expect(res.status).toBe(204);
    });

    it("returns 204 when handoff returns null (no session to merge)", async () => {
      mockService.handoff.mockReturnValue(null);
      const res = await app.request("/api/onboarding/session/handoff", {
        method: "POST",
        headers: { Cookie: "wopr_anon_session=anon-1" },
      });
      expect(res.status).toBe(204);
    });

    it("returns 401 when not authenticated", async () => {
      vi.resetModules();
      const { setOnboardingDeps, onboardingRoutes: freshRoutes } = await import(
        "../../../src/api/routes/onboarding.js"
      );
      setOnboardingDeps(mockService as never, {} as never);
      const noAuthApp = new Hono();
      noAuthApp.route("/api/onboarding", freshRoutes);

      const res = await noAuthApp.request("/api/onboarding/session/handoff", {
        method: "POST",
        headers: { Cookie: "wopr_anon_session=anon-1" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 204 (graceful fallback) when handoff throws", async () => {
      mockService.handoff.mockImplementation(() => {
        throw new Error("db error");
      });
      const res = await app.request("/api/onboarding/session/handoff", {
        method: "POST",
        headers: { Cookie: "wopr_anon_session=anon-1" },
      });
      expect(res.status).toBe(204);
    });
  });

  describe("POST /session (anonymous cookie)", () => {
    it("sets wopr_anon_session cookie when creating anonymous session", async () => {
      vi.resetModules();
      const anonSession = makeSession({ userId: null, anonymousId: "anon-123" });
      const localMock = {
        createSession: vi.fn().mockResolvedValue(anonSession),
        getHistory: vi.fn(),
        inject: vi.fn(),
        upgradeAnonymousToUser: vi.fn(),
        handoff: vi.fn(),
      };
      const { setOnboardingDeps, onboardingRoutes: freshRoutes } = await import(
        "../../../src/api/routes/onboarding.js"
      );
      setOnboardingDeps(localMock as never, {} as never);

      const anonApp = new Hono();
      anonApp.route("/api/onboarding", freshRoutes);

      const res = await anonApp.request("/api/onboarding/session", {
        method: "POST",
        headers: { "x-anonymous-id": "anon-123" },
      });
      expect(res.status).toBe(201);
      const setCookieHeader = res.headers.get("set-cookie");
      expect(setCookieHeader).toContain("wopr_anon_session=anon-123");
      expect(setCookieHeader).toContain("HttpOnly");
    });

    it("does not set anonymous cookie for authenticated session", async () => {
      vi.resetModules();
      const userSession = makeSession({ userId: "u1", anonymousId: null });
      const localMock = {
        createSession: vi.fn().mockResolvedValue(userSession),
        getHistory: vi.fn(),
        inject: vi.fn(),
        upgradeAnonymousToUser: vi.fn(),
        handoff: vi.fn(),
      };
      const { setOnboardingDeps, onboardingRoutes: freshRoutes } = await import(
        "../../../src/api/routes/onboarding.js"
      );
      setOnboardingDeps(localMock as never, {} as never);

      const authApp = new Hono();
      authApp.use("*", async (c, next) => {
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        c.set("user" as never, { id: "u1" } as never);
        await next();
      });
      authApp.route("/api/onboarding", freshRoutes);

      const res = await authApp.request("/api/onboarding/session", { method: "POST" });
      expect(res.status).toBe(201);
      const setCookieHeader = res.headers.get("set-cookie");
      expect(setCookieHeader).toBeNull();
    });
  });
});
