import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthEnv } from "../../auth/index.js";
import type { IOnboardingSessionRepository } from "../../onboarding/drizzle-onboarding-session-repository.js";
import type { OnboardingService } from "../../onboarding/onboarding-service.js";

const ANON_SESSION_COOKIE = "wopr_anon_session";
const ANON_SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours in seconds
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || ".wopr.bot";

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

    // Set anonymous cookie when creating an anonymous session
    if (!userId && session.anonymousId) {
      setCookie(c, ANON_SESSION_COOKIE, session.anonymousId, {
        path: "/",
        domain: COOKIE_DOMAIN,
        maxAge: ANON_SESSION_MAX_AGE,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      });
    }

    return c.json({ sessionId: session.id, woprSessionName: session.woprSessionName }, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /api/onboarding/session/handoff — claim anonymous session after auth
// Must be registered before the :id routes to avoid route shadowing
onboardingRoutes.post("/session/handoff", async (c) => {
  const service = getService();
  const userId = c.get("user")?.id as string | undefined;

  if (!userId) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const anonymousId = getCookie(c, ANON_SESSION_COOKIE);
  if (!anonymousId) {
    return c.body(null, 204);
  }

  try {
    const session = await service.handoff(anonymousId, userId);

    // Always clear the anonymous cookie after attempting handoff
    deleteCookie(c, ANON_SESSION_COOKIE, { path: "/", domain: COOKIE_DOMAIN });

    if (!session) {
      return c.body(null, 204);
    }

    return c.json({ sessionId: session.id, woprSessionName: session.woprSessionName, resumed: true });
  } catch (_err) {
    // Graceful fallback: never block auth flow
    deleteCookie(c, ANON_SESSION_COOKIE, { path: "/", domain: COOKIE_DOMAIN });
    return c.body(null, 204);
  }
});

// GET /api/onboarding/session/:id/history — return conversation history
onboardingRoutes.get("/session/:id/history", async (c) => {
  const service = getService();
  const id = c.req.param("id");
  const limitParam = c.req.query("limit");
  const limitRaw = limitParam ? Number(limitParam) : 50;
  const limit = Number.isNaN(limitRaw) ? 50 : Math.min(200, Math.max(1, limitRaw));

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
    const session = await service.upgradeAnonymousToUser(anonymousId, userId);
    if (!session) {
      return c.json({ error: "Anonymous session not found" }, 404);
    }
    return c.json({ sessionId: session.id });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
