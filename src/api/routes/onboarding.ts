import { Hono } from "hono";
import type { AuthEnv } from "../../auth/index.js";
import type { OnboardingService } from "../../onboarding/onboarding-service.js";
import type { IOnboardingSessionRepository } from "../../onboarding/onboarding-session-repository.js";

let _service: OnboardingService | null = null;

export function setOnboardingDeps(service: OnboardingService, _repo: IOnboardingSessionRepository): void {
  _service = service;
}

function getService(): OnboardingService {
  if (!_service) throw new Error("OnboardingService not initialized");
  return _service;
}

// BOUNDARY(WOP-805/WOP-1020): REST is the correct layer for onboarding endpoints.
// These serve the onboarding widget — unauthenticated or loosely auth'd, not the
// dashboard UI. Anonymous sessions are identified by x-anonymous-id header.
export const onboardingRoutes = new Hono<AuthEnv>();

// POST /api/onboarding/session — create or return existing session
onboardingRoutes.post("/session", async (c) => {
  const service = getService();
  const userId = c.get("user")?.id as string | undefined;
  const anonymousId = c.req.header("x-anonymous-id") ?? undefined;

  if (!userId && !anonymousId) {
    return c.json({ error: "Either authenticated user or x-anonymous-id header required" }, 400);
  }

  try {
    const session = await service.createSession({ userId, anonymousId });
    return c.json({ sessionId: session.id, woprSessionName: session.woprSessionName }, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /api/onboarding/session/:id/history — return conversation history
onboardingRoutes.get("/session/:id/history", async (c) => {
  const service = getService();
  const id = c.req.param("id");
  const limitParam = c.req.query("limit");
  const limit = limitParam ? Number(limitParam) : 50;

  try {
    const history = await service.getHistory(id, limit);
    return c.json({ history });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("not found")) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ error: msg }, 500);
  }
});

// POST /api/onboarding/session/:id/upgrade — upgrade anonymous to user session
onboardingRoutes.post("/session/:id/upgrade", async (c) => {
  const service = getService();
  const userId = c.get("user")?.id as string | undefined;
  const anonymousId = c.req.header("x-anonymous-id") ?? undefined;

  if (!userId) {
    return c.json({ error: "Must be authenticated to upgrade session" }, 401);
  }
  if (!anonymousId) {
    return c.json({ error: "x-anonymous-id header required" }, 400);
  }

  try {
    const session = service.upgradeAnonymousToUser(anonymousId, userId);
    if (!session) {
      return c.json({ error: "Anonymous session not found" }, 404);
    }
    return c.json({ sessionId: session.id });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
