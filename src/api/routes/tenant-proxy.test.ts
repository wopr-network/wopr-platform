import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildUpstreamHeaders, extractTenantSubdomain, tenantProxyMiddleware } from "./tenant-proxy.js";

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
});
