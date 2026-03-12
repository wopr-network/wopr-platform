import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { logger } from "@wopr-network/platform-core/config/logger";
import type { IOnboardingSessionRepository } from "@wopr-network/platform-core/onboarding/drizzle-onboarding-session-repository";
import { GraduationError, type GraduationService } from "@wopr-network/platform-core/onboarding/graduation-service";
import type { OnboardingService } from "@wopr-network/platform-core/onboarding/onboarding-service";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const ANON_SESSION_COOKIE = "wopr_anon_session";
const ANON_SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours in seconds
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || ".wopr.bot";

/** RFC 4122 UUID format (any version). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _service: OnboardingService | null = null;
let _graduationService: GraduationService | null = null;

export function setOnboardingDeps(
  service: OnboardingService,
  _repo: IOnboardingSessionRepository,
  graduationService?: GraduationService,
): void {
  _service = service;
  _graduationService = graduationService ?? null;
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

  if (anonymousId && !UUID_RE.test(anonymousId)) {
    return c.json({ error: "Invalid anonymous ID format — must be a UUID" }, 400);
  }

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
    logger.error("Failed to create onboarding session", { err });
    return c.json({ error: "Internal server error" }, 500);
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

  // Ownership check: fetch session and verify caller identity
  const session = await service.getSession(id);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const userId = c.get("user")?.id as string | undefined;
  const anonymousId = c.req.header("x-anonymous-id") ?? undefined;

  if (anonymousId && !UUID_RE.test(anonymousId)) {
    return c.json({ error: "Invalid anonymous ID format — must be a UUID" }, 400);
  }

  // If the session belongs to a registered user, only a matching authenticated userId grants access.
  // If the session is anonymous (no userId), only a matching anonymousId from an unauthenticated
  // caller grants access. An authenticated user must never satisfy the anonymous branch, which
  // would allow IDOR via a forged x-anonymous-id header.
  const ownerMatch =
    session.userId !== null
      ? userId === session.userId
      : !userId && !!anonymousId && anonymousId === session.anonymousId;

  if (!ownerMatch) {
    return c.json({ error: "Session not found" }, 404);
  }

  const limitParam = c.req.query("limit");
  const limitRaw = limitParam ? Number(limitParam) : 50;
  const limit = Number.isNaN(limitRaw) ? 50 : Math.min(200, Math.max(1, limitRaw));

  try {
    const history = await service.getHistory(id, limit);
    return c.json({ history });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes("not found")) {
      return c.json({ error: "Session not found" }, 404);
    }
    logger.error("Failed to fetch onboarding session history", { err });
    return c.json({ error: "Internal server error" }, 500);
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
  if (!UUID_RE.test(anonymousId)) {
    return c.json({ error: "Invalid anonymous ID format — must be a UUID" }, 400);
  }

  // Ownership check: verify the session identified by :id belongs to the caller's anonymousId.
  // Use 404 (not 403) to avoid leaking session existence.
  const id = c.req.param("id");
  const existing = await service.getSession(id);
  if (!existing || existing.anonymousId !== anonymousId) {
    return c.json({ error: "Session not found" }, 404);
  }

  try {
    const session = await service.upgradeAnonymousToUser(anonymousId, userId);
    if (!session) {
      return c.json({ error: "Anonymous session not found" }, 404);
    }
    return c.json({ sessionId: session.id });
  } catch (err) {
    logger.error("Failed to upgrade onboarding session", { err });
    return c.json({ error: "Internal server error" }, 500);
  }
});

// POST /api/onboarding/session/:id/graduate — trigger graduation
onboardingRoutes.post("/session/:id/graduate", async (c) => {
  const userId = c.get("user")?.id as string | undefined;
  if (!userId) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const sessionId = c.req.param("id");

  // Ownership check
  const session = await getService().getSession(sessionId);
  if (!session || session.userId !== userId) {
    return c.json({ error: "Session not found" }, 404);
  }

  if (!_graduationService) {
    return c.json({ error: "Graduation service not available" }, 503);
  }
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const path = body.path;
  if (path !== "byok" && path !== "hosted") {
    return c.json({ error: 'path must be "byok" or "hosted"' }, 400);
  }

  try {
    const result = await _graduationService.graduate(sessionId, path);
    return c.json(result);
  } catch (err) {
    if (err instanceof GraduationError) {
      if (err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
      if (err.code === "ALREADY_GRADUATED") return c.json({ error: err.message }, 409);
      if (err.code === "NO_BOT_INSTANCE") return c.json({ error: err.message }, 422);
      if (err.code === "UNAUTHENTICATED") return c.json({ error: err.message }, 403);
    }
    logger.error("Failed to graduate onboarding session", { err });
    return c.json({ error: "Internal server error" }, 500);
  }
});
