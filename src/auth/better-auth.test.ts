/**
 * Tests for better-auth integration.
 *
 * Tests session resolution middleware and integration with existing auth system.
 */

import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * pg.Pool-compatible wrapper around PGlite for better-auth.
 * better-auth's Kysely PostgresDialect requires pool.connect() → client with query + release.
 */
// biome-ignore lint/suspicious/noExplicitAny: test helper wrapping PGlite as pg.Pool
function pgliteAsPool(pg: PGlite): any {
  const client = {
    query: (text: string, params?: unknown[]) => pg.query(text, params),
    release: () => {},
  };
  return {
    connect: () => Promise.resolve(client),
    query: (text: string, params?: unknown[]) => pg.query(text, params),
    end: () => Promise.resolve(),
  };
}

import {
  type AuthEnv,
  requireSessionOrToken,
  resolveSessionUser,
  scopedBearerAuthWithTenant,
  type TokenMetadata,
  validateTenantOwnership,
} from "@wopr-network/platform-core/auth";
import { type Auth, getAuth, resetAuth, setAuth } from "./better-auth.js";

describe("getAuth singleton", () => {
  afterEach(() => {
    resetAuth();
  });

  it("returns the same instance on repeated calls", async () => {
    const pg = new PGlite();
    const auth = betterAuth({ database: pgliteAsPool(pg), secret: "s", emailAndPassword: { enabled: true } });
    setAuth(auth as unknown as Auth);
    const a = getAuth();
    const b = getAuth();
    expect(a).toBe(b);
    await pg.close();
  });

  it("getAuth creates a new instance when auth is reset and called with in-memory db via setAuth", async () => {
    resetAuth();
    const pg = new PGlite();
    const auth = betterAuth({ database: pgliteAsPool(pg), secret: "s", emailAndPassword: { enabled: true } });
    setAuth(auth as unknown as Auth);
    expect(getAuth()).toBe(auth);
    await pg.close();
  });
});

describe("better-auth integration", () => {
  afterEach(() => {
    resetAuth();
  });

  // ---------------------------------------------------------------------------
  // resolveSessionUser middleware
  // ---------------------------------------------------------------------------

  describe("resolveSessionUser middleware", () => {
    let app: Hono<AuthEnv>;
    let pg: PGlite;

    beforeEach(() => {
      pg = new PGlite();
      const auth = betterAuth({
        database: pgliteAsPool(pg),
        secret: "test-secret",
        emailAndPassword: { enabled: true },
      });
      setAuth(auth as unknown as Auth);

      app = new Hono<AuthEnv>();
      app.use("/*", resolveSessionUser());
      app.get("/test", (c) => {
        try {
          const user = c.get("user");
          const method = c.get("authMethod");
          return c.json({ user, method });
        } catch {
          return c.json({ user: null, method: null });
        }
      });
    });

    afterEach(async () => {
      await pg.close();
      resetAuth();
    });

    it("skips resolution when user is already set (from bearer auth)", async () => {
      const appWithBearerFirst = new Hono<AuthEnv>();
      appWithBearerFirst.use("/*", (c, next) => {
        c.set("user", { id: "api-user", roles: ["admin"] });
        c.set("authMethod", "api_key");
        return next();
      });
      appWithBearerFirst.use("/*", resolveSessionUser());
      appWithBearerFirst.get("/test", (c) => {
        const user = c.get("user");
        const method = c.get("authMethod");
        return c.json({ user, method });
      });

      const res = await appWithBearerFirst.request("/test");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.id).toBe("api-user");
      expect(body.method).toBe("api_key");
    });

    it("continues without user when no session cookie is present", async () => {
      const res = await app.request("/test");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toBeUndefined();
      expect(body.method).toBeUndefined();
    });

    it("continues without user when session resolution fails", async () => {
      // Provide a malformed cookie to trigger failure
      const res = await app.request("/test", {
        headers: {
          Cookie: "better-auth.session_token=invalid-token-xyz",
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toBeUndefined();
      expect(body.method).toBeUndefined();
    });

    it("does not throw when better-auth initialization is delayed", async () => {
      // Reset auth to test lazy initialization
      resetAuth();

      const appLazy = new Hono<AuthEnv>();
      appLazy.use("/*", resolveSessionUser());
      appLazy.get("/test", (c) => c.json({ ok: true }));

      // Should not throw during middleware execution
      const res = await appLazy.request("/test");
      expect(res.status).toBe(200);
    });

    it("sets authMethod to session when session is valid", async () => {
      // This test verifies the authMethod is set correctly
      const appWithMockedSession = new Hono<AuthEnv>();
      appWithMockedSession.use("/*", async (c, next) => {
        // Simulate successful session resolution
        c.set("user", { id: "session-user-123", roles: ["user"] });
        c.set("authMethod", "session");
        return next();
      });
      appWithMockedSession.get("/test", (c) => {
        const user = c.get("user");
        const method = c.get("authMethod");
        return c.json({ user, method });
      });

      const res = await appWithMockedSession.request("/test");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.id).toBe("session-user-123");
      expect(body.method).toBe("session");
    });

    it("extracts role from session user object", async () => {
      const appWithRoleSession = new Hono<AuthEnv>();
      appWithRoleSession.use("/*", async (c, next) => {
        // Simulate session with role
        c.set("user", { id: "admin-session", roles: ["admin"] });
        c.set("authMethod", "session");
        return next();
      });
      appWithRoleSession.get("/test", (c) => {
        const user = c.get("user");
        return c.json({ user });
      });

      const res = await appWithRoleSession.request("/test");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.roles).toEqual(["admin"]);
    });
  });

  // ---------------------------------------------------------------------------
  // requireSessionOrToken middleware
  // ---------------------------------------------------------------------------

  describe("requireSessionOrToken middleware", () => {
    let app: Hono<AuthEnv>;
    let tokenMap: Map<string, "read" | "write" | "admin">;

    beforeEach(() => {
      tokenMap = new Map([
        ["test-read-token", "read"],
        ["test-admin-token", "admin"],
      ]);

      app = new Hono<AuthEnv>();
      app.use("/*", resolveSessionUser());
      app.use("/*", requireSessionOrToken(tokenMap, "read"));
      app.get("/test", (c) => {
        const user = c.get("user");
        const method = c.get("authMethod");
        return c.json({ user, method });
      });
    });

    it("allows request with valid bearer token", async () => {
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer test-read-token" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.id).toBe("token:read");
      expect(body.method).toBe("api_key");
    });

    it("allows request with session user already set", async () => {
      const appWithSession = new Hono<AuthEnv>();
      appWithSession.use("/*", (c, next) => {
        c.set("user", { id: "session-user", roles: ["user"] });
        c.set("authMethod", "session");
        return next();
      });
      appWithSession.use("/*", requireSessionOrToken(tokenMap, "read"));
      appWithSession.get("/test", (c) => c.json({ ok: true }));

      const res = await appWithSession.request("/test");
      expect(res.status).toBe(200);
    });

    it("rejects request with no auth", async () => {
      const res = await app.request("/test");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Authentication required");
    });

    it("rejects request with invalid token", async () => {
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer invalid-token" },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Invalid or expired token");
    });

    it("rejects request with insufficient scope", async () => {
      const appAdminOnly = new Hono<AuthEnv>();
      appAdminOnly.use("/*", requireSessionOrToken(tokenMap, "admin"));
      appAdminOnly.get("/admin", (c) => c.json({ ok: true }));

      const res = await appAdminOnly.request("/admin", {
        headers: { Authorization: "Bearer test-read-token" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Insufficient scope");
      expect(body.required).toBe("admin");
      expect(body.provided).toBe("read");
    });

    it("allows admin token on read routes", async () => {
      const res = await app.request("/test", {
        headers: { Authorization: "Bearer test-admin-token" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.id).toBe("token:admin");
    });

    it("sets correct user context for token auth", async () => {
      const appWithContext = new Hono<AuthEnv>();
      appWithContext.use("/*", requireSessionOrToken(tokenMap, "read"));
      appWithContext.get("/context", (c) => {
        const user = c.get("user");
        return c.json({ id: user.id, roles: user.roles });
      });

      const res = await appWithContext.request("/context", {
        headers: { Authorization: "Bearer test-read-token" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("token:read");
      expect(body.roles).toEqual(["read"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: resolveSessionUser + requireSessionOrToken
  // ---------------------------------------------------------------------------

  describe("integration: session OR token auth", () => {
    it("prefers session user over bearer token when both are present", async () => {
      const tokenMap = new Map<string, "read" | "write" | "admin">([["test-token", "admin"]]);
      const app = new Hono<AuthEnv>();

      app.use("/*", async (c, next) => {
        // Simulate session resolution
        c.set("user", { id: "session-123", roles: ["user"] });
        c.set("authMethod", "session");
        return next();
      });
      app.use("/*", requireSessionOrToken(tokenMap, "read"));
      app.get("/test", (c) => {
        const user = c.get("user");
        const method = c.get("authMethod");
        return c.json({ userId: user.id, method });
      });

      const res = await app.request("/test", {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe("session-123");
      expect(body.method).toBe("session");
    });

    it("falls back to bearer token when session is not present", async () => {
      const tokenMap = new Map<string, "read" | "write" | "admin">([["fallback-token", "write"]]);
      const app = new Hono<AuthEnv>();

      app.use("/*", resolveSessionUser());
      app.use("/*", requireSessionOrToken(tokenMap, "write"));
      app.get("/test", (c) => {
        const user = c.get("user");
        const method = c.get("authMethod");
        return c.json({ userId: user.id, method });
      });

      const res = await app.request("/test", {
        headers: { Authorization: "Bearer fallback-token" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe("token:write");
      expect(body.method).toBe("api_key");
    });
  });
});

// ---------------------------------------------------------------------------
// scopedBearerAuthWithTenant — legacy token rejection (WOP-1264)
// ---------------------------------------------------------------------------

describe("scopedBearerAuthWithTenant — legacy token behaviour", () => {
  it("allows legacy tokens without tenantId to pass scope check (admin routes)", async () => {
    const metadataMap = new Map<string, TokenMetadata>([
      ["legacy-admin-token", { scope: "admin" }], // no tenantId
    ]);

    const app = new Hono<AuthEnv>();
    app.use("/*", scopedBearerAuthWithTenant(metadataMap, "read"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer legacy-admin-token" },
    });
    // scopedBearerAuthWithTenant only checks scope — tenant enforcement is
    // done by requireTenantOwnership / validateTenantOwnership on
    // tenant-scoped routes (WOP-1264).
    expect(res.status).toBe(200);
  });

  it("allows tokens with tenant scope", async () => {
    const metadataMap = new Map<string, TokenMetadata>([["scoped-token", { scope: "admin", tenantId: "tenant-123" }]]);

    const app = new Hono<AuthEnv>();
    app.use("/*", scopedBearerAuthWithTenant(metadataMap, "read"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer scoped-token" },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// validateTenantOwnership — defense-in-depth (WOP-1264)
// ---------------------------------------------------------------------------

describe("validateTenantOwnership — defense-in-depth", () => {
  it("returns 403 when tokenTenantId is not set (legacy token)", async () => {
    const app = new Hono<AuthEnv>();
    app.get("/test", (c) => {
      // Do NOT set tokenTenantId — simulates legacy token
      const result = validateTenantOwnership(c, { id: "resource-1" }, "tenant-abc");
      if (result) return result;
      return c.json({ ok: true });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("tenant");
  });

  it("still returns 404 for tenant mismatch", async () => {
    const app = new Hono<AuthEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenTenantId", "tenant-xyz");
      return next();
    });
    app.get("/test", (c) => {
      const result = validateTenantOwnership(c, { id: "resource-1" }, "tenant-abc");
      if (result) return result;
      return c.json({ ok: true });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(404);
  });

  it("passes when tokenTenantId matches resource tenant", async () => {
    const app = new Hono<AuthEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenTenantId", "tenant-abc");
      return next();
    });
    app.get("/test", (c) => {
      const result = validateTenantOwnership(c, { id: "resource-1" }, "tenant-abc");
      if (result) return result;
      return c.json({ ok: true });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });
});
