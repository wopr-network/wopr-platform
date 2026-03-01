/**
 * Integration tests for auth routes (/api/auth/*).
 * Tests route wiring, body forwarding, middleware ordering, and response passthrough.
 * Uses vi.mock to avoid real PostgreSQL connections.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fleet/services to prevent DB initialization at import time.
// Uses importOriginal spread so we don't need to enumerate all 85+ exports —
// only override functions that would trigger real DB connections.
vi.mock("../../fleet/services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../fleet/services.js")>();
  return {
    ...actual,
    getPool: vi.fn(),
    getDb: vi.fn(),
    getAuditDb: vi.fn(),
    initFleet: vi.fn(),
    getOrgRepo: vi.fn(() => ({ ensurePersonalTenant: vi.fn() })),
    getEvidenceCollector: vi.fn(),
    getMarketplacePluginRepo: vi.fn(),
    getOnboardingScriptRepo: vi.fn(),
    getRateLimitRepo: vi.fn(() => ({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      increment: vi.fn().mockResolvedValue(1),
    })),
    getCreditLedger: vi.fn(),
    getAdminNotifier: vi.fn(),
    getNodeRepo: vi.fn(),
    getBotInstanceRepo: vi.fn(),
    getBotProfileRepo: vi.fn(),
    getRecoveryRepo: vi.fn(),
    getSpendingCapStore: vi.fn(),
    getGpuNodeRepo: vi.fn(),
    getAdminNotesRepo: vi.fn(),
    getTenantStatusRepo: vi.fn(),
    getBulkOpsRepo: vi.fn(),
    getNotificationQueueStore: vi.fn(),
    getNotificationPrefsStore: vi.fn(),
    getConnectionRegistry: vi.fn(),
    getCommandBus: vi.fn(),
    getHeartbeatProcessor: vi.fn(),
    getOrphanCleaner: vi.fn(),
    getNodeRegistrar: vi.fn(),
    getRecoveryOrchestrator: vi.fn(),
    getMigrationOrchestrator: vi.fn(),
    getNodeDrainer: vi.fn(),
    getFleetEventRepo: vi.fn(),
    getCircuitBreakerRepo: vi.fn(),
    getHeartbeatWatchdog: vi.fn(),
    getInferenceWatchdog: vi.fn(),
    getDOClient: vi.fn(),
    getNodeProvisioner: vi.fn(),
    getGpuNodeProvisioner: vi.fn(),
    getAdminAuditLog: vi.fn(),
    getRestoreLogStore: vi.fn(),
    getBackupStatusStore: vi.fn(),
    getSnapshotManager: vi.fn(),
    getRestoreService: vi.fn(),
    getRegistrationTokenStore: vi.fn(),
  };
});

// Mock rate-limit-repository to avoid DB calls in lazy rate-limit middleware
vi.mock("../../db/rate-limit-repository.js", () => ({
  DrizzleRateLimitRepository: vi.fn(),
}));

// Control getAuth to return our mock handler
const mockHandler = vi.fn<(req: Request) => Promise<Response>>();

vi.mock("../../auth/better-auth.js", () => ({
  getAuth: vi.fn(() => ({
    handler: mockHandler,
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  })),
  resetAuth: vi.fn(),
  setAuth: vi.fn(),
}));

// Import app AFTER mocks are set up
const { app } = await import("../../api/app.js");

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("auth routes integration", () => {
  beforeEach(() => {
    mockHandler.mockReset();
  });

  describe("POST /api/auth/sign-in/email", () => {
    it("returns 200 with session cookie on valid credentials", async () => {
      mockHandler.mockResolvedValueOnce(
        jsonResponse({ user: { id: "user-1", email: "test@example.com" }, session: { token: "sess-abc" } }, 200, {
          "Set-Cookie": "better-auth.session_token=sess-abc; Path=/; HttpOnly",
        }),
      );

      const res = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com", password: "ValidPass1!xyz" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.id).toBe("user-1");
      expect(mockHandler).toHaveBeenCalledOnce();
      // Verify the request was forwarded to better-auth handler
      const forwardedReq = mockHandler.mock.calls[0][0];
      expect(forwardedReq.method).toBe("POST");
      expect(forwardedReq.url).toContain("/api/auth/sign-in/email");
    });

    it("returns 401 for invalid credentials", async () => {
      mockHandler.mockResolvedValueOnce(jsonResponse({ error: "Invalid email or password" }, 401));

      const res = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com", password: "WrongPass1!xyz" }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe("POST /api/auth/sign-out", () => {
    it("returns 200 and clears session cookie", async () => {
      mockHandler.mockResolvedValueOnce(
        jsonResponse({ success: true }, 200, {
          "Set-Cookie": "better-auth.session_token=; Path=/; HttpOnly; Max-Age=0",
        }),
      );

      const res = await app.request("/api/auth/sign-out", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "better-auth.session_token=sess-abc",
        },
      });

      expect(res.status).toBe(200);
      const setCookie = res.headers.get("Set-Cookie");
      expect(setCookie).toContain("Max-Age=0");
    });

    it("returns 200 even without active session (idempotent)", async () => {
      mockHandler.mockResolvedValueOnce(jsonResponse({ success: true }, 200));

      const res = await app.request("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/auth/get-session", () => {
    it("returns session data when valid cookie is present", async () => {
      mockHandler.mockResolvedValueOnce(
        jsonResponse({
          user: { id: "user-1", email: "test@example.com", role: "user" },
          session: { token: "sess-abc", expiresAt: "2026-03-01T00:00:00Z" },
        }),
      );

      const res = await app.request("/api/auth/get-session", {
        headers: { Cookie: "better-auth.session_token=sess-abc" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.id).toBe("user-1");
      // GET requests are forwarded directly (not buffered)
      const forwardedReq = mockHandler.mock.calls[0][0];
      expect(forwardedReq.method).toBe("GET");
    });

    it("returns 401 when no session cookie present", async () => {
      mockHandler.mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401));

      const res = await app.request("/api/auth/get-session");

      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/auth/callback/github (OAuth callback)", () => {
    it("returns redirect on valid OAuth callback", async () => {
      mockHandler.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            Location: "http://localhost:3001/dashboard",
            "Set-Cookie": "better-auth.session_token=oauth-sess; Path=/; HttpOnly",
          },
        }),
      );

      const res = await app.request("/api/auth/callback/github?code=valid-code&state=valid-state");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("http://localhost:3001/dashboard");
    });

    it("returns error on invalid OAuth state", async () => {
      mockHandler.mockResolvedValueOnce(jsonResponse({ error: "Invalid state parameter" }, 400));

      const res = await app.request("/api/auth/callback/github?code=some-code&state=tampered-state");

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it("returns error when code is missing", async () => {
      mockHandler.mockResolvedValueOnce(jsonResponse({ error: "Missing code parameter" }, 400));

      const res = await app.request("/api/auth/callback/github?state=valid-state");

      expect(res.status).toBe(400);
    });
  });

  describe("rate limiting", () => {
    it("returns 429 when sign-in rate limit is exceeded", async () => {
      mockHandler.mockResolvedValueOnce(
        jsonResponse({ error: "Too many requests. Please try again later." }, 429, { "Retry-After": "900" }),
      );

      const res = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com", password: "ValidPass1!xyz" }),
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toMatch(/too many/i);
    });

    it("returns 429 when sign-up rate limit is exceeded", async () => {
      mockHandler.mockResolvedValueOnce(
        jsonResponse({ error: "Too many requests. Please try again later." }, 429, { "Retry-After": "3600" }),
      );

      const res = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "new@example.com",
          password: "ValidPass1!xyz",
          name: "Test",
        }),
      });

      expect(res.status).toBe(429);
    });
  });

  describe("POST /api/auth/sign-up/email", () => {
    it("forwards to better-auth on valid sign-up", async () => {
      mockHandler.mockResolvedValueOnce(
        jsonResponse({ user: { id: "new-user-1", email: "new@example.com" } }, 200, {
          "Set-Cookie": "better-auth.session_token=new-sess; Path=/; HttpOnly",
        }),
      );

      const res = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "new@example.com",
          password: "ValidPass1!xyz",
          name: "New User",
        }),
      });

      expect(res.status).toBe(200);
      expect(mockHandler).toHaveBeenCalledOnce();
    });

    it("rejects password failing complexity before reaching better-auth", async () => {
      const res = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "new@example.com",
          password: "alllowercase1!", // no uppercase
          name: "New User",
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/uppercase/i);
      // mockHandler should NOT have been called — middleware rejected it
      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  describe("request forwarding", () => {
    it("forwards POST body correctly to better-auth handler", async () => {
      const requestBody = { email: "body-test@example.com", password: "ValidPass1!xyz" };
      mockHandler.mockImplementationOnce(async (req: Request) => {
        const body = await req.json();
        return jsonResponse({ received: body });
      });

      const res = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.received.email).toBe("body-test@example.com");
    });

    it("forwards GET requests directly without body buffering", async () => {
      mockHandler.mockImplementationOnce(async (req: Request) => {
        return jsonResponse({ method: req.method, url: req.url });
      });

      const res = await app.request("/api/auth/get-session");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.method).toBe("GET");
    });
  });
});
