import type { AuthEnv, AuthUser } from "@wopr-network/platform-core/auth";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { OnboardingSession } from "../../onboarding/drizzle-onboarding-session-repository.js";
import type { OnboardingService } from "../../onboarding/onboarding-service.js";
import { onboardingRoutes, setOnboardingDeps } from "./onboarding.js";

function fakeSession(overrides: Partial<OnboardingSession> = {}): OnboardingSession {
  return {
    id: "sess-1",
    userId: "user-owner",
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

function buildApp(session: OnboardingSession | null, userId?: string, _anonymousId?: string) {
  const mockService = {
    getSession: vi.fn().mockResolvedValue(session),
    getHistory: vi.fn().mockResolvedValue([{ role: "assistant", content: "hello" }]),
    createSession: vi.fn(),
    inject: vi.fn(),
    upgradeAnonymousToUser: vi.fn(),
    handoff: vi.fn(),
  };
  const mockRepo = {
    getById: vi.fn(),
    getByUserId: vi.fn(),
    getByAnonymousId: vi.fn(),
    getActiveByAnonymousId: vi.fn(),
    create: vi.fn(),
    upgradeAnonymousToUser: vi.fn(),
    setStatus: vi.fn(),
    graduate: vi.fn(),
    getGraduatedByUserId: vi.fn(),
  };
  setOnboardingDeps(mockService as unknown as OnboardingService, mockRepo);

  const app = new Hono<AuthEnv>();
  // Inject fake auth context
  app.use("*", async (c, next) => {
    if (userId) {
      c.set("user", { id: userId, roles: [] } satisfies AuthUser);
    }
    await next();
  });
  app.route("/api/onboarding", onboardingRoutes);
  return { app, mockService };
}

describe("GET /api/onboarding/session/:id/history", () => {
  it("returns history when authenticated user owns the session", async () => {
    const session = fakeSession({ userId: "user-owner" });
    const { app } = buildApp(session, "user-owner");
    const res = await app.request("/api/onboarding/session/sess-1/history");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.history)).toBe(true);
  });

  it("returns 404 when authenticated user does NOT own the session", async () => {
    const session = fakeSession({ userId: "user-owner" });
    const { app } = buildApp(session, "user-attacker");
    const res = await app.request("/api/onboarding/session/sess-1/history");
    expect(res.status).toBe(404);
  });

  it("returns history when anonymous user owns the session via x-anonymous-id", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const session = fakeSession({ userId: null, anonymousId: uuid });
    const { app } = buildApp(session, undefined, uuid);
    const res = await app.request("/api/onboarding/session/sess-1/history", {
      headers: { "x-anonymous-id": uuid },
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 when anonymous user does NOT own the session", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const otherUuid = "660e8400-e29b-41d4-a716-446655440000";
    const session = fakeSession({ userId: null, anonymousId: uuid });
    const { app } = buildApp(session, undefined, otherUuid);
    const res = await app.request("/api/onboarding/session/sess-1/history", {
      headers: { "x-anonymous-id": otherUuid },
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when x-anonymous-id is not a valid UUID", async () => {
    const session = fakeSession({ userId: null, anonymousId: "anon-123" });
    const { app } = buildApp(session);
    const res = await app.request("/api/onboarding/session/sess-1/history", {
      headers: { "x-anonymous-id": "not-a-uuid" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid anonymous ID format");
  });

  it("accepts a valid UUID v4 in x-anonymous-id", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const session = fakeSession({ userId: null, anonymousId: uuid });
    const { app } = buildApp(session);
    const res = await app.request("/api/onboarding/session/sess-1/history", {
      headers: { "x-anonymous-id": uuid },
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 when session does not exist", async () => {
    const { app } = buildApp(null, "user-owner");
    const res = await app.request("/api/onboarding/session/nonexistent/history");
    expect(res.status).toBe(404);
  });

  it("returns 404 when no auth and no anonymous-id header", async () => {
    const session = fakeSession();
    const { app } = buildApp(session);
    const res = await app.request("/api/onboarding/session/sess-1/history");
    expect(res.status).toBe(404);
  });

  it("returns 404 when authenticated user forges x-anonymous-id to access anonymous session (IDOR)", async () => {
    // The session belongs to an anonymous user, not any authenticated user.
    const victimUuid = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const session = fakeSession({ userId: null, anonymousId: victimUuid });
    // Authenticated attacker sends the victim's anonymousId in the header.
    const { app } = buildApp(session, "user-attacker");
    const res = await app.request("/api/onboarding/session/sess-1/history", {
      headers: { "x-anonymous-id": victimUuid },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/onboarding/session", () => {
  it("returns 400 when x-anonymous-id is not a valid UUID", async () => {
    const { app } = buildApp(null);
    const res = await app.request("/api/onboarding/session", {
      method: "POST",
      headers: { "x-anonymous-id": "short" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid anonymous ID format");
  });
});

describe("POST /api/onboarding/session/:id/upgrade", () => {
  it("returns 404 when x-anonymous-id does not match the session identified by :id (IDOR)", async () => {
    // IDOR: attacker passes their own anonymousId but victim's session :id.
    // getSession returns the victim's session (anonymousId: "anon-victim").
    // Without an ownership check the code would proceed with upgradeAnonymousToUser.
    const victimUuid = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const attackerUuid = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const victimSession = fakeSession({ userId: null, anonymousId: victimUuid });
    const { app, mockService } = buildApp(victimSession, "user-attacker");
    // Simulate attacker's own session upgrading if called (should NOT happen)
    mockService.upgradeAnonymousToUser.mockResolvedValue(
      fakeSession({ userId: "user-attacker", anonymousId: attackerUuid }),
    );
    const res = await app.request("/api/onboarding/session/sess-1/upgrade", {
      method: "POST",
      headers: { "x-anonymous-id": attackerUuid },
    });
    expect(res.status).toBe(404);
    // upgradeAnonymousToUser must never be called when ownership check fails
    expect(mockService.upgradeAnonymousToUser).not.toHaveBeenCalled();
  });

  it("returns 404 when session does not exist", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const { app } = buildApp(null, "user-owner");
    const res = await app.request("/api/onboarding/session/nonexistent/upgrade", {
      method: "POST",
      headers: { "x-anonymous-id": uuid },
    });
    expect(res.status).toBe(404);
  });

  it("allows upgrade when x-anonymous-id matches the session identified by :id", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const session = fakeSession({ userId: null, anonymousId: uuid });
    const { app, mockService } = buildApp(session, "user-owner");
    mockService.upgradeAnonymousToUser.mockResolvedValue({ ...session, userId: "user-owner" });
    const res = await app.request("/api/onboarding/session/sess-1/upgrade", {
      method: "POST",
      headers: { "x-anonymous-id": uuid },
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/onboarding/session/:id/graduate", () => {
  it("returns 404 when authenticated user does NOT own the session", async () => {
    const session = fakeSession({ userId: "user-owner" });
    const { app } = buildApp(session, "user-attacker");
    const res = await app.request("/api/onboarding/session/sess-1/graduate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "byok" }),
    });
    expect(res.status).toBe(404);
  });

  it("allows graduation when authenticated user owns the session", async () => {
    const session = fakeSession({ userId: "user-owner" });
    const { app } = buildApp(session, "user-owner");
    // Note: will get 503 because _graduationService is null in test, but that's
    // AFTER the ownership check passes — proving ownership check passed
    const res = await app.request("/api/onboarding/session/sess-1/graduate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "byok" }),
    });
    // 503 = graduation service not available (expected in test), NOT 404
    expect(res.status).toBe(503);
  });
});
