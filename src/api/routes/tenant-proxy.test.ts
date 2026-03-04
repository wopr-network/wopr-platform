import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildUpstreamHeaders, extractTenantSubdomain, tenantProxyMiddleware } from "./tenant-proxy.js";

// Mock logger (use vi.hoisted so the factory can reference the mock before hoisting)
const mockLogger = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("../../config/logger.js", () => ({ logger: mockLogger }));

// ---------------------------------------------------------------------------
// Unit tests: extractTenantSubdomain
// ---------------------------------------------------------------------------

describe("extractTenantSubdomain", () => {
  it("extracts valid subdomain from host", () => {
    expect(extractTenantSubdomain("alice.wopr.bot")).toBe("alice");
  });

  it("returns null for root domain", () => {
    expect(extractTenantSubdomain("wopr.bot")).toBeNull();
  });

  it("returns null for reserved subdomains", () => {
    expect(extractTenantSubdomain("app.wopr.bot")).toBeNull();
    expect(extractTenantSubdomain("api.wopr.bot")).toBeNull();
    expect(extractTenantSubdomain("admin.wopr.bot")).toBeNull();
    expect(extractTenantSubdomain("www.wopr.bot")).toBeNull();
    expect(extractTenantSubdomain("staging.wopr.bot")).toBeNull();
  });

  it("returns null for wrong domain", () => {
    expect(extractTenantSubdomain("alice.example.com")).toBeNull();
  });

  it("returns null for sub-sub-domains", () => {
    expect(extractTenantSubdomain("a.b.wopr.bot")).toBeNull();
  });

  it("strips port before matching", () => {
    expect(extractTenantSubdomain("alice.wopr.bot:3000")).toBe("alice");
  });

  it("normalizes to lowercase", () => {
    expect(extractTenantSubdomain("Alice.Wopr.Bot")).toBe("alice");
  });

  it("rejects invalid DNS labels", () => {
    expect(extractTenantSubdomain("-bad.wopr.bot")).toBeNull();
    expect(extractTenantSubdomain("bad-.wopr.bot")).toBeNull();
  });

  it("accepts hyphenated subdomains", () => {
    expect(extractTenantSubdomain("my-bot.wopr.bot")).toBe("my-bot");
  });

  it("accepts numeric subdomains", () => {
    expect(extractTenantSubdomain("123.wopr.bot")).toBe("123");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: buildUpstreamHeaders
// ---------------------------------------------------------------------------

describe("buildUpstreamHeaders", () => {
  it("forwards only allowlisted headers", () => {
    const incoming = new Headers({
      "content-type": "application/json",
      accept: "text/html",
      cookie: "session=abc",
      "x-request-id": "req-1",
      authorization: "Bearer secret",
    });
    const result = buildUpstreamHeaders(incoming, "user-1", "alice");
    expect(result.get("content-type")).toBe("application/json");
    expect(result.get("accept")).toBe("text/html");
    expect(result.get("x-request-id")).toBe("req-1");
    expect(result.get("cookie")).toBeNull();
    expect(result.get("authorization")).toBeNull();
  });

  it("injects x-wopr-user-id and x-wopr-tenant-id", () => {
    const incoming = new Headers();
    const result = buildUpstreamHeaders(incoming, "user-42", "mybotname");
    expect(result.get("x-wopr-user-id")).toBe("user-42");
    expect(result.get("x-wopr-tenant-id")).toBe("mybotname");
  });
});

// ---------------------------------------------------------------------------
// Middleware tests: tenantProxyMiddleware
// ---------------------------------------------------------------------------

// Mock the proxy singleton
vi.mock("../../proxy/singleton.js", () => ({
  getProxyManager: () => mockProxyManager,
  hydrateProxyRoutes: vi.fn().mockResolvedValue(undefined),
}));

// Mock better-auth — default: no session (unauthenticated)
const mockGetSession = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("../../auth/better-auth.js", () => ({
  getAuth: vi.fn(() => ({
    api: { getSession: mockGetSession },
  })),
}));

// Mock bot profile repository — returns a bot profile with tenantId
const mockProfileStoreGet = vi.hoisted(() => vi.fn().mockResolvedValue(null));

// Mock org member repo for tenant access validation
const mockFindMember = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("../../fleet/services.js", () => ({
  getBotProfileRepo: vi.fn(() => ({
    get: (...args: unknown[]) => mockProfileStoreGet(...args),
    save: vi.fn(),
    delete: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
  })),
  getOrgMemberRepo: vi.fn(() => ({
    findMember: (...args: unknown[]) => mockFindMember(...args),
    listMembers: vi.fn().mockResolvedValue([]),
    addMember: vi.fn(),
    updateMemberRole: vi.fn(),
    removeMember: vi.fn(),
    countAdminsAndOwners: vi.fn().mockResolvedValue(0),
    listInvites: vi.fn().mockResolvedValue([]),
    createInvite: vi.fn(),
    findInviteById: vi.fn().mockResolvedValue(null),
    findInviteByToken: vi.fn().mockResolvedValue(null),
    deleteInvite: vi.fn(),
    deleteAllMembers: vi.fn(),
    deleteAllInvites: vi.fn(),
  })),
}));

const mockProxyManager = {
  getRoutes: vi.fn(),
  addRoute: vi.fn(),
  removeRoute: vi.fn(),
  updateHealth: vi.fn(),
};

describe("tenantProxyMiddleware", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default: no session (unauthenticated)
    mockGetSession.mockResolvedValue(null);
    mockLogger.warn.mockClear();
    mockProfileStoreGet.mockResolvedValue(null);
    mockFindMember.mockResolvedValue(null);
    app = new Hono();
    app.use("/*", tenantProxyMiddleware);
    // Fallback route for requests that pass through the middleware
    app.all("/*", (c) => c.json({ passedThrough: true }));
  });

  it("passes through when no host header", async () => {
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passedThrough).toBe(true);
  });

  it("passes through for root domain", async () => {
    const res = await app.request("http://wopr.bot/test", {
      headers: { host: "wopr.bot" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passedThrough).toBe(true);
  });

  it("passes through for reserved subdomains", async () => {
    const res = await app.request("http://app.wopr.bot/test", {
      headers: { host: "app.wopr.bot" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passedThrough).toBe(true);
  });

  it("returns 404 when tenant subdomain has no route", async () => {
    mockProxyManager.getRoutes.mockReturnValue([]);
    const res = await app.request("http://alice.wopr.bot/test", {
      headers: { host: "alice.wopr.bot" },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Tenant not found");
  });

  it("returns 503 when tenant route is unhealthy", async () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { subdomain: "alice", upstreamHost: "wopr-alice", upstreamPort: 7437, healthy: false, instanceId: "i1" },
    ]);
    const res = await app.request("http://alice.wopr.bot/test", {
      headers: { host: "alice.wopr.bot" },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Instance unavailable");
  });

  it("proxies to upstream when tenant route is healthy", async () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { subdomain: "alice", upstreamHost: "wopr-alice", upstreamPort: 7437, healthy: true, instanceId: "i1" },
    ]);
    mockGetSession.mockResolvedValue({ user: { id: "user-42", role: "user" } });
    mockProfileStoreGet.mockResolvedValue({ id: "i1", tenantId: "user-42", name: "alice" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ upstream: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      const res = await app.request("http://alice.wopr.bot/api/data", {
        headers: { host: "alice.wopr.bot", "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upstream).toBe(true);

      // Verify fetch was called with correct upstream URL
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[0]).toContain("http://wopr-alice:7437/api/data");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 502 when upstream fetch fails", async () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { subdomain: "alice", upstreamHost: "wopr-alice", upstreamPort: 7437, healthy: true, instanceId: "i1" },
    ]);
    mockGetSession.mockResolvedValue({ user: { id: "user-42", role: "user" } });
    mockProfileStoreGet.mockResolvedValue({ id: "i1", tenantId: "user-42", name: "alice" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    try {
      const res = await app.request("http://alice.wopr.bot/test", {
        headers: { host: "alice.wopr.bot" },
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toContain("Bad Gateway");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("logs a warning when session resolution throws and returns 401", async () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { subdomain: "alice", upstreamHost: "wopr-alice", upstreamPort: 7437, healthy: true, instanceId: "i1" },
    ]);
    const authError = new Error("DB connection failed");
    mockGetSession.mockRejectedValue(authError);

    const res = await app.request("http://alice.wopr.bot/test", {
      headers: { host: "alice.wopr.bot" },
    });
    expect(res.status).toBe(401);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Session resolution failed"),
      expect.objectContaining({ err: authError }),
    );
  });

  it("returns 401 when no session exists for tenant request", async () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { subdomain: "alice", upstreamHost: "wopr-alice", upstreamPort: 7437, healthy: true, instanceId: "i1" },
    ]);

    const res = await app.request("http://alice.wopr.bot/test", {
      headers: { host: "alice.wopr.bot" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("proxies when session user is resolved", async () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { subdomain: "alice", upstreamHost: "wopr-alice", upstreamPort: 7437, healthy: true, instanceId: "i1" },
    ]);
    mockGetSession.mockResolvedValue({ user: { id: "user-42", role: "user" } });
    mockProfileStoreGet.mockResolvedValue({ id: "i1", tenantId: "user-42", name: "alice" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ upstream: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      const res = await app.request("http://alice.wopr.bot/api/data", {
        headers: { host: "alice.wopr.bot", cookie: "session=valid" },
      });
      expect(res.status).toBe(200);

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const upstreamHeaders = fetchCall[1]?.headers as Headers;
      expect(upstreamHeaders.get("x-wopr-user-id")).toBe("user-42");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 403 when user is not a member of the target tenant", async () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { subdomain: "alice", upstreamHost: "wopr-alice", upstreamPort: 7437, healthy: true, instanceId: "i1" },
    ]);
    // User "user-99" is authenticated but the bot belongs to tenant "user-alice"
    mockGetSession.mockResolvedValue({ user: { id: "user-99", role: "user" } });
    mockProfileStoreGet.mockResolvedValue({ id: "i1", tenantId: "user-alice", name: "alice" });
    mockFindMember.mockResolvedValue(null); // Not a member of the org

    const res = await app.request("http://alice.wopr.bot/test", {
      headers: { host: "alice.wopr.bot" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Not authorized for this tenant");
  });

  it("allows proxy when user owns the target tenant (personal tenant)", async () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { subdomain: "alice", upstreamHost: "wopr-alice", upstreamPort: 7437, healthy: true, instanceId: "i1" },
    ]);
    // User "user-42" is authenticated and the bot belongs to their personal tenant
    mockGetSession.mockResolvedValue({ user: { id: "user-42", role: "user" } });
    mockProfileStoreGet.mockResolvedValue({ id: "i1", tenantId: "user-42", name: "alice" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ upstream: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      const res = await app.request("http://alice.wopr.bot/api/data", {
        headers: { host: "alice.wopr.bot" },
      });
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows proxy when user is an org member of the target tenant", async () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { subdomain: "alice", upstreamHost: "wopr-alice", upstreamPort: 7437, healthy: true, instanceId: "i1" },
    ]);
    mockGetSession.mockResolvedValue({ user: { id: "user-99", role: "user" } });
    mockProfileStoreGet.mockResolvedValue({ id: "i1", tenantId: "org-acme", name: "alice" });
    // user-99 IS a member of org-acme
    mockFindMember.mockResolvedValue({ id: "m1", orgId: "org-acme", userId: "user-99", role: "member", joinedAt: 0 });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ upstream: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      const res = await app.request("http://alice.wopr.bot/api/data", {
        headers: { host: "alice.wopr.bot" },
      });
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 404 when profile not found for tenant instance", async () => {
    mockProxyManager.getRoutes.mockReturnValue([
      { subdomain: "alice", upstreamHost: "wopr-alice", upstreamPort: 7437, healthy: true, instanceId: "i1" },
    ]);
    mockGetSession.mockResolvedValue({ user: { id: "user-42", role: "user" } });
    mockProfileStoreGet.mockResolvedValue(null); // Profile not found

    const res = await app.request("http://alice.wopr.bot/test", {
      headers: { host: "alice.wopr.bot" },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Tenant not found");
  });
});
