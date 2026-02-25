import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { OnboardingSession } from "../../../src/onboarding/onboarding-session-repository.js";

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

describe("onboardingRoutes", () => {
  let app: Hono;

  beforeEach(async () => {
    // Reset module registry to get fresh setOnboardingDeps
    vi.resetModules();

    const mockService = {
      createSession: vi.fn().mockResolvedValue(makeSession()),
      getHistory: vi.fn().mockResolvedValue([{ ts: 1, from: "user", content: "hi", type: "text" }]),
      inject: vi.fn().mockResolvedValue("response"),
      upgradeAnonymousToUser: vi.fn().mockReturnValue(makeSession()),
    };
    const mockRepo = {};

    const { setOnboardingDeps, onboardingRoutes } = await import(
      "../../../src/api/routes/onboarding.js"
    );
    setOnboardingDeps(mockService as never, mockRepo as never);

    app = new Hono();
    // Inject a mock user into context
    app.use("*", async (c, next) => {
      c.set("user" as never, { id: "u1" } as never);
      await next();
    });
    app.route("/api/onboarding", onboardingRoutes);
  });

  it("POST /session returns 201 with sessionId", async () => {
    const res = await app.request("/api/onboarding/session", { method: "POST" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe("s1");
  });

  it("POST /session with anonymous id header", async () => {
    const anonApp = new Hono();
    vi.resetModules();
    const mockService = {
      createSession: vi.fn().mockResolvedValue(makeSession({ userId: null, anonymousId: "anon-x" })),
      getHistory: vi.fn().mockResolvedValue([]),
      inject: vi.fn().mockResolvedValue(""),
      upgradeAnonymousToUser: vi.fn(),
    };
    const { setOnboardingDeps, onboardingRoutes: freshRoutes } = await import(
      "../../../src/api/routes/onboarding.js"
    );
    setOnboardingDeps(mockService as never, {} as never);
    anonApp.route("/api/onboarding", freshRoutes);

    const res = await anonApp.request("/api/onboarding/session", {
      method: "POST",
      headers: { "x-anonymous-id": "anon-x" },
    });
    expect(res.status).toBe(201);
  });

  it("POST /session returns 400 without userId or anonymousId", async () => {
    const bareApp = new Hono();
    vi.resetModules();
    const { setOnboardingDeps, onboardingRoutes: freshRoutes } = await import(
      "../../../src/api/routes/onboarding.js"
    );
    setOnboardingDeps({ createSession: vi.fn() } as never, {} as never);
    bareApp.route("/api/onboarding", freshRoutes);

    const res = await bareApp.request("/api/onboarding/session", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("GET /session/:id/history returns history", async () => {
    const res = await app.request("/api/onboarding/session/s1/history");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: unknown[] };
    expect(body.history).toHaveLength(1);
  });

  it("GET /session/:id/history returns 404 when not found", async () => {
    vi.resetModules();
    const mockService = {
      createSession: vi.fn(),
      getHistory: vi.fn().mockRejectedValue(new Error("Session not found: missing")),
      inject: vi.fn(),
      upgradeAnonymousToUser: vi.fn(),
    };
    const { setOnboardingDeps, onboardingRoutes: freshRoutes } = await import(
      "../../../src/api/routes/onboarding.js"
    );
    setOnboardingDeps(mockService as never, {} as never);
    const notFoundApp = new Hono();
    notFoundApp.route("/api/onboarding", freshRoutes);

    const res = await notFoundApp.request("/api/onboarding/session/missing/history");
    expect(res.status).toBe(404);
  });
});
