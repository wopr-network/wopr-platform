import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionAuth, dualAuth, type SessionAuthEnv } from "./middleware.js";
import type { Auth } from "./better-auth.js";
import type { AuthUser } from "./index.js";

function mockAuth(sessionResult: { user: { id: string; role?: string } } | null = null): Auth {
  return {
    api: {
      getSession: vi.fn().mockResolvedValue(sessionResult),
    },
  } as unknown as Auth;
}

describe("sessionAuth middleware", () => {
  it("sets user and authMethod for valid session", async () => {
    const auth = mockAuth({ user: { id: "user-1", role: "admin" } });

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", sessionAuth(auth));
    app.get("/test", (c) => {
      const user = c.get("user");
      const method = c.get("authMethod");
      return c.json({ userId: user.id, roles: user.roles, method });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("user-1");
    expect(body.roles).toEqual(["admin", "user"]);
    expect(body.method).toBe("session");
  });

  it("sets user roles as ['user'] for non-admin", async () => {
    const auth = mockAuth({ user: { id: "user-2" } });

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", sessionAuth(auth));
    app.get("/test", (c) => {
      const user = c.get("user");
      return c.json({ roles: user.roles });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles).toEqual(["user"]);
  });

  it("returns 401 when no session found", async () => {
    const auth = mockAuth(null);

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", sessionAuth(auth));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("returns 401 when session has no user", async () => {
    const auth = {
      api: {
        getSession: vi.fn().mockResolvedValue({ user: null }),
      },
    } as unknown as Auth;

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", sessionAuth(auth));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });

  it("returns 401 when getSession throws", async () => {
    const auth = {
      api: {
        getSession: vi.fn().mockRejectedValue(new Error("DB error")),
      },
    } as unknown as Auth;

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", sessionAuth(auth));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication failed");
  });
});

describe("dualAuth middleware", () => {
  const apiTokens = new Map<string, AuthUser>([
    ["api-key-admin", { id: "admin-1", roles: ["admin"] }],
    ["api-key-reader", { id: "reader-1", roles: ["user"] }],
  ]);

  it("authenticates with session cookie first", async () => {
    const auth = mockAuth({ user: { id: "session-user", role: "admin" } });

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", dualAuth(auth, apiTokens));
    app.get("/test", (c) => {
      const user = c.get("user");
      const method = c.get("authMethod");
      return c.json({ userId: user.id, method });
    });

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("session-user");
    expect(body.method).toBe("session");
  });

  it("falls back to bearer token when session fails", async () => {
    const auth = mockAuth(null);

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", dualAuth(auth, apiTokens));
    app.get("/test", (c) => {
      const user = c.get("user");
      const method = c.get("authMethod");
      return c.json({ userId: user.id, method });
    });

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer api-key-admin" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("admin-1");
    expect(body.method).toBe("api_key");
  });

  it("returns 401 when neither session nor token is valid", async () => {
    const auth = mockAuth(null);

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", dualAuth(auth, apiTokens));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("returns 401 when bearer token is invalid", async () => {
    const auth = mockAuth(null);

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", dualAuth(auth, apiTokens));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer bad-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization header is not Bearer scheme", async () => {
    const auth = mockAuth(null);

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", dualAuth(auth, apiTokens));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  it("works without apiTokens (session-only mode)", async () => {
    const auth = mockAuth(null);

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", dualAuth(auth));
    app.get("/test", (c) => c.json({ ok: true }));

    // No session, no tokens -> 401
    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });

  it("falls back to bearer when session throws", async () => {
    const auth = {
      api: {
        getSession: vi.fn().mockRejectedValue(new Error("Session DB error")),
      },
    } as unknown as Auth;

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", dualAuth(auth, apiTokens));
    app.get("/test", (c) => {
      const user = c.get("user");
      return c.json({ userId: user.id });
    });

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer api-key-admin" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("admin-1");
  });

  it("copies API user roles to prevent mutation", async () => {
    const auth = mockAuth(null);

    const app = new Hono<SessionAuthEnv>();
    app.use("/*", dualAuth(auth, apiTokens));
    app.get("/test", (c) => {
      const user = c.get("user");
      return c.json({ roles: user.roles });
    });

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer api-key-reader" },
    });
    const body = await res.json();
    expect(body.roles).toEqual(["user"]);

    // Original should not be mutated
    expect(apiTokens.get("api-key-reader")!.roles).toEqual(["user"]);
  });
});
