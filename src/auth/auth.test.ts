import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { type AuthEnv, type AuthUser, extractBearerToken, requireRole } from "./index.js";

// ---------------------------------------------------------------------------
// extractBearerToken
// ---------------------------------------------------------------------------

describe("extractBearerToken", () => {
  it("extracts token from valid Bearer header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("handles case-insensitive Bearer prefix", () => {
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
    expect(extractBearerToken("BEARER abc123")).toBe("abc123");
    expect(extractBearerToken("BeArEr abc123")).toBe("abc123");
  });

  it("returns null for undefined header", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractBearerToken("")).toBeNull();
  });

  it("returns null for non-Bearer scheme", () => {
    expect(extractBearerToken("Basic abc123")).toBeNull();
    expect(extractBearerToken("Digest abc123")).toBeNull();
  });

  it("returns null for Bearer with no token", () => {
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
  });

  it("trims whitespace from header and token", () => {
    expect(extractBearerToken("  Bearer   abc123  ")).toBe("abc123");
  });

  it("preserves token characters", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiMSJ9.sig";
    expect(extractBearerToken(`Bearer ${token}`)).toBe(token);
  });
});

// ---------------------------------------------------------------------------
// requireRole middleware
// ---------------------------------------------------------------------------

describe("requireRole middleware", () => {
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    app = new Hono<AuthEnv>();
    // Inject user directly for testing requireRole in isolation
    app.use("/*", async (c, next) => {
      const authHeader = c.req.header("X-Test-Roles");
      if (authHeader !== undefined) {
        const roles = authHeader ? authHeader.split(",").map((r) => r.trim()) : [];
        const userId = c.req.header("X-Test-User-Id") ?? "test-user";
        c.set("user", { id: userId, roles } satisfies AuthUser);
        c.set("authMethod", "api_key");
      }
      return next();
    });
    app.get("/admin", requireRole("admin"), (c) => {
      return c.json({ ok: true, user: c.get("user").id });
    });
    app.get("/editor", requireRole("editor"), (c) => {
      return c.json({ ok: true });
    });
  });

  it("allows user with required role", async () => {
    const res = await app.request("/admin", {
      headers: { "X-Test-User-Id": "admin-user", "X-Test-Roles": "admin,user" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user).toBe("admin-user");
  });

  it("rejects user without required role", async () => {
    const res = await app.request("/admin", {
      headers: { "X-Test-User-Id": "basic-user", "X-Test-Roles": "user" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Insufficient permissions");
    expect(body.required).toBe("admin");
  });

  it("rejects user with empty roles array", async () => {
    const res = await app.request("/admin", {
      headers: { "X-Test-User-Id": "no-roles", "X-Test-Roles": "" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 401 when no auth (requireRole without user set)", async () => {
    const noAuthApp = new Hono<AuthEnv>();
    noAuthApp.get("/admin", requireRole("admin"), (c) => c.json({ ok: true }));

    const res = await noAuthApp.request("/admin");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("works with multiple roles (only one required)", async () => {
    const res = await app.request("/editor", {
      headers: { "X-Test-Roles": "user,editor,admin" },
    });
    expect(res.status).toBe(200);
  });

  it("role check is case-sensitive", async () => {
    const res = await app.request("/admin", {
      headers: { "X-Test-Roles": "Admin" },
    });
    expect(res.status).toBe(403);
  });
});
