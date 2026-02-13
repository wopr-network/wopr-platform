import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuthEnv,
  type AuthUser,
  extractBearerToken,
  requireAuth,
  requireRole,
  SessionStore,
  verifyBearerToken,
} from "./index.js";

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(60_000); // 60s TTL
  });

  describe("create", () => {
    it("creates a session with a unique ID", () => {
      const user: AuthUser = { id: "u1", roles: ["user"] };
      const session = store.create(user);

      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe("string");
      expect(session.userId).toBe("u1");
      expect(session.roles).toEqual(["user"]);
    });

    it("sets correct expiry based on TTL", () => {
      const user: AuthUser = { id: "u1", roles: [] };
      const before = Date.now();
      const session = store.create(user);
      const after = Date.now();

      expect(session.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(session.expiresAt).toBeLessThanOrEqual(after + 60_000);
    });

    it("creates independent sessions for same user", () => {
      const user: AuthUser = { id: "u1", roles: ["admin"] };
      const s1 = store.create(user);
      const s2 = store.create(user);

      expect(s1.id).not.toBe(s2.id);
      expect(store.size).toBe(2);
    });

    it("copies roles array (does not share reference)", () => {
      const roles = ["user"];
      const user: AuthUser = { id: "u1", roles };
      const session = store.create(user);

      roles.push("admin");
      expect(session.roles).toEqual(["user"]);
    });
  });

  describe("validate", () => {
    it("returns session for valid session ID", () => {
      const user: AuthUser = { id: "u1", roles: ["user"] };
      const session = store.create(user);

      const result = store.validate(session.id);
      expect(result).not.toBeNull();
      expect(result?.userId).toBe("u1");
    });

    it("returns null for unknown session ID", () => {
      expect(store.validate("nonexistent-id")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(store.validate("")).toBeNull();
    });

    it("returns null and removes expired session", () => {
      vi.useFakeTimers();
      try {
        const user: AuthUser = { id: "u1", roles: [] };
        const session = store.create(user);

        // Advance time past TTL
        vi.advanceTimersByTime(61_000);

        expect(store.validate(session.id)).toBeNull();
        // Session should be cleaned up
        expect(store.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns session just before expiry", () => {
      vi.useFakeTimers();
      try {
        const user: AuthUser = { id: "u1", roles: [] };
        const session = store.create(user);

        // Advance to 1ms before expiry
        vi.advanceTimersByTime(59_999);

        expect(store.validate(session.id)).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("revoke", () => {
    it("removes an existing session", () => {
      const user: AuthUser = { id: "u1", roles: [] };
      const session = store.create(user);

      expect(store.revoke(session.id)).toBe(true);
      expect(store.validate(session.id)).toBeNull();
      expect(store.size).toBe(0);
    });

    it("returns false for nonexistent session", () => {
      expect(store.revoke("nonexistent")).toBe(false);
    });
  });

  describe("purgeExpired", () => {
    it("removes only expired sessions", () => {
      vi.useFakeTimers();
      try {
        const u1: AuthUser = { id: "u1", roles: [] };
        const u2: AuthUser = { id: "u2", roles: [] };

        store.create(u1);

        // Advance 30s (within TTL)
        vi.advanceTimersByTime(30_000);
        store.create(u2);

        // Advance another 31s (first session expired, second still valid)
        vi.advanceTimersByTime(31_000);

        const removed = store.purgeExpired();
        expect(removed).toBe(1);
        expect(store.size).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns 0 when no sessions are expired", () => {
      const user: AuthUser = { id: "u1", roles: [] };
      store.create(user);

      expect(store.purgeExpired()).toBe(0);
      expect(store.size).toBe(1);
    });

    it("handles empty store", () => {
      expect(store.purgeExpired()).toBe(0);
    });
  });

  describe("size", () => {
    it("tracks session count", () => {
      expect(store.size).toBe(0);

      const user: AuthUser = { id: "u1", roles: [] };
      const s1 = store.create(user);
      expect(store.size).toBe(1);

      store.create(user);
      expect(store.size).toBe(2);

      store.revoke(s1.id);
      expect(store.size).toBe(1);
    });
  });

  describe("default TTL", () => {
    it("uses 1 hour default when no TTL provided", () => {
      const defaultStore = new SessionStore();
      const user: AuthUser = { id: "u1", roles: [] };
      const session = defaultStore.create(user);

      // Default is 3,600,000ms (1 hour)
      const expectedExpiry = session.createdAt + 3_600_000;
      expect(session.expiresAt).toBe(expectedExpiry);
    });
  });
});

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
// verifyBearerToken
// ---------------------------------------------------------------------------

describe("verifyBearerToken", () => {
  let store: SessionStore;
  let apiTokens: Map<string, AuthUser>;

  beforeEach(() => {
    store = new SessionStore(60_000);
    apiTokens = new Map([
      ["api-key-admin", { id: "admin-1", roles: ["admin"] }],
      ["api-key-user", { id: "user-1", roles: ["user"] }],
    ]);
  });

  it("returns user for valid API token", () => {
    const user = verifyBearerToken("api-key-admin", store, apiTokens);
    expect(user).toEqual({ id: "admin-1", roles: ["admin"] });
  });

  it("returns user for valid session token", () => {
    const sessionUser: AuthUser = { id: "session-user", roles: ["user"] };
    const session = store.create(sessionUser);

    const user = verifyBearerToken(session.id, store);
    expect(user).not.toBeNull();
    expect(user?.id).toBe("session-user");
  });

  it("authenticates via API token header", () => {
    const user = verifyBearerToken("api-key-admin", store, apiTokens);
    expect(user).toEqual({ id: "admin-1", roles: ["admin"] });
  });

  it("returns null for empty token", () => {
    expect(verifyBearerToken("", store, apiTokens)).toBeNull();
  });

  it("returns null for unknown token", () => {
    expect(verifyBearerToken("unknown-token", store, apiTokens)).toBeNull();
  });

  it("returns null for expired session token", () => {
    vi.useFakeTimers();
    try {
      const sessionUser: AuthUser = { id: "u1", roles: [] };
      const session = store.create(sessionUser);

      vi.advanceTimersByTime(61_000);

      expect(verifyBearerToken(session.id, store)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("works without apiTokens map", () => {
    const sessionUser: AuthUser = { id: "u1", roles: ["user"] };
    const session = store.create(sessionUser);

    const user = verifyBearerToken(session.id, store);
    expect(user).not.toBeNull();
    expect(user?.id).toBe("u1");
  });
});

// ---------------------------------------------------------------------------
// requireAuth middleware
// ---------------------------------------------------------------------------

describe("requireAuth middleware", () => {
  let store: SessionStore;
  let apiTokens: Map<string, AuthUser>;
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    store = new SessionStore(60_000);
    apiTokens = new Map([["api-key-admin", { id: "admin-1", roles: ["admin"] }]]);

    app = new Hono<AuthEnv>();
    app.use("/*", requireAuth(store, apiTokens));
    app.get("/protected", (c) => {
      const user = c.get("user");
      const method = c.get("authMethod");
      return c.json({ userId: user.id, roles: user.roles, authMethod: method });
    });
  });

  it("rejects request with no Authorization header", async () => {
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("rejects request with empty Authorization header", async () => {
    const res = await app.request("/protected", {
      headers: { Authorization: "" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("rejects request with non-Bearer scheme", async () => {
    const res = await app.request("/protected", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("rejects request with Bearer but no token value", async () => {
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("rejects request with invalid bearer token", async () => {
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid or expired token");
  });

  it("authenticates with valid API token", async () => {
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer api-key-admin" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("admin-1");
    expect(body.roles).toEqual(["admin"]);
    expect(body.authMethod).toBe("api_key");
  });

  it("authenticates with valid session token", async () => {
    const session = store.create({ id: "session-user", roles: ["user", "editor"] });

    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("session-user");
    expect(body.roles).toEqual(["user", "editor"]);
    expect(body.authMethod).toBe("session");
  });

  it("rejects expired session token", async () => {
    vi.useFakeTimers();
    try {
      const session = store.create({ id: "u1", roles: [] });

      vi.advanceTimersByTime(61_000);

      const res = await app.request("/protected", {
        headers: { Authorization: `Bearer ${session.id}` },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Invalid or expired token");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects revoked session token", async () => {
    const session = store.create({ id: "u1", roles: [] });
    store.revoke(session.id);

    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(401);
  });

  it("works without apiTokens (session-only mode)", async () => {
    const sessionOnlyApp = new Hono<AuthEnv>();
    sessionOnlyApp.use("/*", requireAuth(store));
    sessionOnlyApp.get("/protected", (c) => c.json({ ok: true }));

    const session = store.create({ id: "u1", roles: [] });
    const res = await sessionOnlyApp.request("/protected", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects malformed bearer token (random garbage)", async () => {
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer !@#$%^&*()" },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// requireRole middleware
// ---------------------------------------------------------------------------

describe("requireRole middleware", () => {
  let store: SessionStore;
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    store = new SessionStore(60_000);

    app = new Hono<AuthEnv>();
    app.use("/*", requireAuth(store));
    app.get("/admin", requireRole("admin"), (c) => {
      return c.json({ ok: true, user: c.get("user").id });
    });
    app.get("/editor", requireRole("editor"), (c) => {
      return c.json({ ok: true });
    });
  });

  it("allows user with required role", async () => {
    const session = store.create({ id: "admin-user", roles: ["admin", "user"] });

    const res = await app.request("/admin", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user).toBe("admin-user");
  });

  it("rejects user without required role", async () => {
    const session = store.create({ id: "basic-user", roles: ["user"] });

    const res = await app.request("/admin", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Insufficient permissions");
    expect(body.required).toBe("admin");
  });

  it("rejects user with empty roles array", async () => {
    const session = store.create({ id: "no-roles", roles: [] });

    const res = await app.request("/admin", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(403);
  });

  it("returns 401 when no auth (requireRole after missing requireAuth)", async () => {
    // Build an app where requireRole is used without requireAuth
    const noAuthApp = new Hono<AuthEnv>();
    noAuthApp.get("/admin", requireRole("admin"), (c) => c.json({ ok: true }));

    const res = await noAuthApp.request("/admin");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("works with multiple roles (only one required)", async () => {
    const session = store.create({ id: "u1", roles: ["user", "editor", "admin"] });

    const res = await app.request("/editor", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(200);
  });

  it("role check is case-sensitive", async () => {
    const session = store.create({ id: "u1", roles: ["Admin"] });

    const res = await app.request("/admin", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Integration: full auth flow
// ---------------------------------------------------------------------------

describe("full auth flow", () => {
  it("session create -> authenticate -> role check -> revoke", async () => {
    const store = new SessionStore(60_000);
    const app = new Hono<AuthEnv>();
    app.use("/api/*", requireAuth(store));
    app.get("/api/admin", requireRole("admin"), (c) => c.json({ ok: true }));
    app.get("/api/profile", (c) => c.json({ user: c.get("user").id }));

    // 1. Create session
    const session = store.create({ id: "admin-1", roles: ["admin", "user"] });

    // 2. Access profile (authenticated, no role needed)
    const profileRes = await app.request("/api/profile", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(profileRes.status).toBe(200);
    const profileBody = await profileRes.json();
    expect(profileBody.user).toBe("admin-1");

    // 3. Access admin endpoint (requires admin role)
    const adminRes = await app.request("/api/admin", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(adminRes.status).toBe(200);

    // 4. Revoke session
    store.revoke(session.id);

    // 5. Verify session is invalid
    const afterRevoke = await app.request("/api/profile", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("API token auth with role check", async () => {
    const store = new SessionStore();
    const apiTokens = new Map<string, AuthUser>([
      ["fleet-token-xyz", { id: "fleet-service", roles: ["service", "admin"] }],
    ]);

    const app = new Hono<AuthEnv>();
    app.use("/api/*", requireAuth(store, apiTokens));
    app.get("/api/admin", requireRole("admin"), (c) => {
      return c.json({ method: c.get("authMethod") });
    });

    const res = await app.request("/api/admin", {
      headers: { Authorization: "Bearer fleet-token-xyz" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe("api_key");
  });

  it("mixed auth: API key user lacks role that session user has", async () => {
    const store = new SessionStore();
    const apiTokens = new Map<string, AuthUser>([["readonly-key", { id: "readonly", roles: ["viewer"] }]]);

    const app = new Hono<AuthEnv>();
    app.use("/api/*", requireAuth(store, apiTokens));
    app.get("/api/edit", requireRole("editor"), (c) => c.json({ ok: true }));

    // API key user cannot edit
    const apiRes = await app.request("/api/edit", {
      headers: { Authorization: "Bearer readonly-key" },
    });
    expect(apiRes.status).toBe(403);

    // Session user with editor role can edit
    const session = store.create({ id: "editor-user", roles: ["editor"] });
    const sessionRes = await app.request("/api/edit", {
      headers: { Authorization: `Bearer ${session.id}` },
    });
    expect(sessionRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("session with zero TTL expires immediately", () => {
    vi.useFakeTimers();
    const store = new SessionStore(0);
    const session = store.create({ id: "u1", roles: [] });

    // Advance even 1ms
    vi.advanceTimersByTime(1);
    expect(store.validate(session.id)).toBeNull();
  });

  it("concurrent sessions for same user are independent", () => {
    const store = new SessionStore(60_000);
    const user: AuthUser = { id: "u1", roles: ["user"] };

    const s1 = store.create(user);
    const s2 = store.create(user);

    store.revoke(s1.id);
    expect(store.validate(s1.id)).toBeNull();
    expect(store.validate(s2.id)).not.toBeNull();
  });

  it("very long token string is handled gracefully", () => {
    const store = new SessionStore();
    const longToken = "x".repeat(10_000);
    expect(verifyBearerToken(longToken, store)).toBeNull();
  });

  it("token with special characters is handled", () => {
    const store = new SessionStore();
    expect(verifyBearerToken("token\nwith\nnewlines", store)).toBeNull();
    expect(verifyBearerToken("token\twith\ttabs", store)).toBeNull();
    expect(verifyBearerToken("token with spaces", store)).toBeNull();
  });

  it("multiple purge calls are idempotent", () => {
    vi.useFakeTimers();
    const store = new SessionStore(1000);
    store.create({ id: "u1", roles: [] });

    vi.advanceTimersByTime(2000);

    expect(store.purgeExpired()).toBe(1);
    expect(store.purgeExpired()).toBe(0);
    expect(store.purgeExpired()).toBe(0);
  });
});
