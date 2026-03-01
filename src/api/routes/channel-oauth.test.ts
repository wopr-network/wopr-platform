import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthEnv, AuthUser } from "../../auth/index.js";
import { createTestDb } from "../../test/db.js";
import { DrizzleOAuthStateRepository } from "../drizzle-oauth-state-repository.js";
import { createChannelOAuthRoutes } from "./channel-oauth.js";

// Track all PGlite pools created during tests so we can close them
const activePools: PGlite[] = [];

// ---------------------------------------------------------------------------
// Test app — wraps createChannelOAuthRoutes with controllable session injection
// ---------------------------------------------------------------------------

async function createTestApp(user?: AuthUser) {
  const { db, pool } = await createTestDb();
  activePools.push(pool);
  const repo = new DrizzleOAuthStateRepository(db);
  const routes = createChannelOAuthRoutes(repo);
  const app = new Hono<AuthEnv>();

  // Inject user if provided (simulates resolveSessionUser middleware)
  app.use("/*", async (c, next) => {
    if (user) {
      c.set("user", user);
      c.set("authMethod", "session");
    }
    return next();
  });

  app.route("/", routes);
  return app;
}

// ---------------------------------------------------------------------------
// Shared repo for tests that need to share state (e.g. initiate then poll)
// ---------------------------------------------------------------------------

async function createSharedApp(user?: AuthUser) {
  const { db, pool } = await createTestDb();
  activePools.push(pool);
  const repo = new DrizzleOAuthStateRepository(db);
  const routes = createChannelOAuthRoutes(repo);

  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    if (user) {
      c.set("user", user);
      c.set("authMethod", "session");
    }
    return next();
  });
  app.route("/", routes);
  return app;
}

const authedApp = () => createTestApp({ id: "test-user-id", roles: ["user"] });
const unauthedApp = () => createTestApp();

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(activePools.map((p) => p.close()));
  activePools.length = 0;
});

// ---------------------------------------------------------------------------
// POST /initiate
// ---------------------------------------------------------------------------

describe("POST /initiate", () => {
  it("returns 401 without session", async () => {
    const app = await unauthedApp();
    const res = await app.request("/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "slack" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Authentication required" });
  });

  it("returns 400 for unknown provider", async () => {
    const app = await authedApp();
    const res = await app.request("/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "unknown-provider" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("OAuth not configured for provider: unknown-provider");
  });

  it("returns 400 when Slack env vars not set", async () => {
    const app = await authedApp();
    const savedId = process.env.SLACK_CLIENT_ID;
    const savedSecret = process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;

    try {
      const res = await app.request("/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "slack" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("OAuth not configured for provider: slack");
    } finally {
      if (savedId !== undefined) process.env.SLACK_CLIENT_ID = savedId;
      if (savedSecret !== undefined) process.env.SLACK_CLIENT_SECRET = savedSecret;
    }
  });

  it("returns authorizeUrl and state for Slack when env vars are set", async () => {
    const app = await authedApp();
    process.env.SLACK_CLIENT_ID = "test-client-id";
    process.env.SLACK_CLIENT_SECRET = "test-client-secret";

    try {
      const res = await app.request("/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "slack" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authorizeUrl: string; state: string };
      expect(body.state).toBeTruthy();
      expect(body.authorizeUrl).toContain("https://slack.com/oauth/v2/authorize");
      expect(body.authorizeUrl).toContain("client_id=test-client-id");
      expect(body.authorizeUrl).toContain("channels%3Ahistory");
      expect(body.authorizeUrl).toContain(`state=${body.state}`);
    } finally {
      delete process.env.SLACK_CLIENT_ID;
      delete process.env.SLACK_CLIENT_SECRET;
    }
  });

  it("returns 400 for invalid JSON body", async () => {
    const app = await authedApp();
    const res = await app.request("/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /callback
// ---------------------------------------------------------------------------

describe("GET /callback", () => {
  it("returns error HTML for missing code and state", async () => {
    const app = await unauthedApp();
    const res = await app.request("/callback");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Missing code or state parameter");
    expect(html).toContain("wopr-oauth-callback");
    expect(html).toContain('"error"');
  });

  it("returns error HTML for error query param", async () => {
    const app = await unauthedApp();
    const res = await app.request("/callback?error=access_denied");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("access_denied");
    expect(html).toContain('"error"');
  });

  it("returns error HTML for invalid state", async () => {
    const app = await unauthedApp();
    const res = await app.request("/callback?code=some-code&state=00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Invalid or expired OAuth state");
    expect(html).toContain('"error"');
  });

  it("exchanges code for token and returns success HTML", async () => {
    process.env.SLACK_CLIENT_ID = "test-client-id";
    process.env.SLACK_CLIENT_SECRET = "test-client-secret";

    // Use shared app so initiate and callback share the same repo
    const app = await createSharedApp({ id: "test-user-id", roles: ["user"] });
    const initiateRes = await app.request("/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "slack" }),
    });
    const { state } = (await initiateRes.json()) as { state: string; authorizeUrl: string };

    // Mock the Slack token exchange
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(""),
      json: vi.fn().mockResolvedValue({
        ok: true,
        access_token: "xoxb-real-token-123",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      const res = await app.request(`/callback?code=auth-code-123&state=${state}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Authorization successful");
      expect(html).toContain('"success"');
      expect(html).toContain(state);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.SLACK_CLIENT_ID;
      delete process.env.SLACK_CLIENT_SECRET;
    }
  });
});

// ---------------------------------------------------------------------------
// GET /poll
// ---------------------------------------------------------------------------

describe("GET /poll", () => {
  it("returns 401 without session", async () => {
    const app = await unauthedApp();
    const res = await app.request("/poll?state=00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(401);
  });

  it("returns 400 when state param is missing", async () => {
    const app = await authedApp();
    const res = await app.request("/poll");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Missing state parameter" });
  });

  it("returns pending for unknown state", async () => {
    const app = await authedApp();
    const res = await app.request("/poll?state=00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "pending" });
  });

  it("returns completed token and consumes it (second call returns pending)", async () => {
    process.env.SLACK_CLIENT_ID = "test-client-id";
    process.env.SLACK_CLIENT_SECRET = "test-client-secret";

    const app = await createSharedApp({ id: "test-user-id", roles: ["user"] });

    // Create pending state
    const initiateRes = await app.request("/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "slack" }),
    });
    const { state } = (await initiateRes.json()) as { state: string; authorizeUrl: string };

    // Simulate the callback completing the token exchange
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(""),
      json: vi.fn().mockResolvedValue({
        ok: true,
        access_token: "xoxb-real-token-456",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);
    await app.request(`/callback?code=auth-code&state=${state}`);
    vi.unstubAllGlobals();

    // First poll — should return the token
    const res1 = await app.request(`/poll?state=${state}`);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { status: string; token?: string };
    expect(body1.status).toBe("completed");
    expect(body1.token).toBe("xoxb-real-token-456");

    // Second poll — token consumed, should return pending
    const res2 = await app.request(`/poll?state=${state}`);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2).toMatchObject({ status: "pending" });

    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
  });
});

// ---------------------------------------------------------------------------
// State isolation test (replaces resetChannelOAuthState test)
// ---------------------------------------------------------------------------

describe("state isolation", () => {
  it("state from one app does not leak to another (each has its own in-memory DB)", async () => {
    process.env.SLACK_CLIENT_ID = "id";
    process.env.SLACK_CLIENT_SECRET = "secret";
    const app1 = await createSharedApp({ id: "test-user-id", roles: ["user"] });

    // Create some state in app1
    await app1.request("/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "slack" }),
    });

    // app2 has a fresh DB — polling for any state returns pending
    const app2 = await createSharedApp({ id: "test-user-id", roles: ["user"] });
    const res = await app2.request("/poll?state=00000000-0000-0000-0000-000000000000");
    const body = await res.json();
    expect(body).toMatchObject({ status: "pending" });

    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
  });
});
