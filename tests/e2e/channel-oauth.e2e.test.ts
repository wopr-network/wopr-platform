import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleOAuthStateRepository } from "../../src/api/drizzle-oauth-state-repository.js";
import { createChannelOAuthRoutes } from "../../src/api/routes/channel-oauth.js";
import type { AuthEnv, AuthUser } from "../../src/auth/index.js";
import { createTestDb } from "../../src/test/db.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const activePools: PGlite[] = [];

async function createApp(user?: AuthUser) {
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
  app.route("/api/channel-oauth", routes);
  return { app, pool };
}

const TEST_USER: AuthUser = { id: "e2e-user-id", roles: ["user"] };

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await Promise.allSettled(activePools.map((p) => p.close()));
  activePools.length = 0;
});

// ---------------------------------------------------------------------------
// E2E: Full OAuth round-trip (initiate → callback → poll)
// ---------------------------------------------------------------------------

describe("E2E: channel OAuth — Slack full round-trip", () => {
  let savedSlackClientId: string | undefined;
  let savedSlackClientSecret: string | undefined;

  beforeEach(() => {
    savedSlackClientId = process.env.SLACK_CLIENT_ID;
    savedSlackClientSecret = process.env.SLACK_CLIENT_SECRET;
    process.env.SLACK_CLIENT_ID = "slack-client-id";
    process.env.SLACK_CLIENT_SECRET = "slack-client-secret";
  });

  afterEach(() => {
    if (savedSlackClientId !== undefined) process.env.SLACK_CLIENT_ID = savedSlackClientId;
    else delete process.env.SLACK_CLIENT_ID;
    if (savedSlackClientSecret !== undefined) process.env.SLACK_CLIENT_SECRET = savedSlackClientSecret;
    else delete process.env.SLACK_CLIENT_SECRET;
  });

  it("initiate → callback → poll returns token then pending on second poll", async () => {
    const { app } = await createApp(TEST_USER);

    // Step 1: Initiate OAuth — get back authorizeUrl and state
    const initiateRes = await app.request("/api/channel-oauth/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "slack" }),
    });
    expect(initiateRes.status).toBe(200);
    const { authorizeUrl, state } = (await initiateRes.json()) as { authorizeUrl: string; state: string };
    expect(state).toBeTruthy();
    expect(authorizeUrl).toContain("https://slack.com/oauth/v2/authorize");
    expect(authorizeUrl).toContain(`state=${state}`);
    expect(authorizeUrl).toContain("client_id=slack-client-id");

    // Step 2: Provider redirects to callback with code + state
    // Mock the Slack token exchange endpoint
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue(""),
        json: vi.fn().mockResolvedValue({
          ok: true,
          access_token: "xoxb-e2e-token-abc123",
        }),
      }),
    );

    const callbackRes = await app.request(`/api/channel-oauth/callback?code=auth-code-xyz&state=${state}`);
    expect(callbackRes.status).toBe(200);
    const callbackHtml = await callbackRes.text();
    expect(callbackHtml).toContain("Authorization successful");
    expect(callbackHtml).toContain('"success"');
    expect(callbackHtml).toContain(state);

    // Step 3: Frontend polls for completion — should return token
    const pollRes1 = await app.request(`/api/channel-oauth/poll?state=${state}`);
    expect(pollRes1.status).toBe(200);
    const pollBody1 = (await pollRes1.json()) as { status: string; token?: string };
    expect(pollBody1.status).toBe("completed");
    expect(pollBody1.token).toBe("xoxb-e2e-token-abc123");

    // Step 4: Second poll — token consumed (one-time read)
    const pollRes2 = await app.request(`/api/channel-oauth/poll?state=${state}`);
    expect(pollRes2.status).toBe(200);
    const pollBody2 = await pollRes2.json();
    expect(pollBody2).toMatchObject({ status: "pending" });
  });

  it("unauthenticated user cannot initiate OAuth", async () => {
    const { app } = await createApp(); // no user
    const res = await app.request("/api/channel-oauth/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "slack" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Authentication required" });
  });

  it("unauthenticated user cannot poll for token", async () => {
    const { app } = await createApp(); // no user
    const res = await app.request("/api/channel-oauth/poll?state=00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// E2E: OAuth error cases
// ---------------------------------------------------------------------------

describe("E2E: channel OAuth — error cases", () => {
  let savedSlackClientId: string | undefined;
  let savedSlackClientSecret: string | undefined;

  beforeEach(() => {
    savedSlackClientId = process.env.SLACK_CLIENT_ID;
    savedSlackClientSecret = process.env.SLACK_CLIENT_SECRET;
    process.env.SLACK_CLIENT_ID = "slack-client-id";
    process.env.SLACK_CLIENT_SECRET = "slack-client-secret";
  });

  afterEach(() => {
    if (savedSlackClientId !== undefined) process.env.SLACK_CLIENT_ID = savedSlackClientId;
    else delete process.env.SLACK_CLIENT_ID;
    if (savedSlackClientSecret !== undefined) process.env.SLACK_CLIENT_SECRET = savedSlackClientSecret;
    else delete process.env.SLACK_CLIENT_SECRET;
  });

  it("provider returns error param → callback renders error HTML", async () => {
    const { app } = await createApp(TEST_USER);
    const res = await app.request("/api/channel-oauth/callback?error=access_denied");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("access_denied");
    expect(html).toContain('"error"');
    expect(html).toContain("wopr-oauth-callback");
  });

  it("callback with missing code → error HTML", async () => {
    const { app } = await createApp(TEST_USER);
    const res = await app.request("/api/channel-oauth/callback?state=some-state");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Missing code or state parameter");
    expect(html).toContain('"error"');
  });

  it("callback with invalid/expired state → error HTML", async () => {
    const { app } = await createApp(TEST_USER);
    const res = await app.request("/api/channel-oauth/callback?code=some-code&state=00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Invalid or expired OAuth state");
    expect(html).toContain('"error"');
  });

  it("token exchange failure → error HTML", async () => {
    const { app } = await createApp(TEST_USER);

    // Initiate to get a valid state
    const initiateRes = await app.request("/api/channel-oauth/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "slack" }),
    });
    const { state } = (await initiateRes.json()) as { state: string; authorizeUrl: string };

    // Mock the token exchange to fail
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("Internal Server Error"),
        json: vi.fn().mockResolvedValue({}),
      }),
    );

    const res = await app.request(`/api/channel-oauth/callback?code=bad-code&state=${state}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Token exchange failed");
    expect(html).toContain('"error"');
  });

  it("Slack ok:false in token response → error HTML", async () => {
    const { app } = await createApp(TEST_USER);

    const initiateRes = await app.request("/api/channel-oauth/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "slack" }),
    });
    const { state } = (await initiateRes.json()) as { state: string; authorizeUrl: string };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue(""),
        json: vi.fn().mockResolvedValue({
          ok: false,
          error: "invalid_code",
        }),
      }),
    );

    const res = await app.request(`/api/channel-oauth/callback?code=bad-code&state=${state}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Slack error: invalid_code");
    expect(html).toContain('"error"');
  });

  it("unknown provider → 400", async () => {
    const { app } = await createApp(TEST_USER);
    const res = await app.request("/api/channel-oauth/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "discord" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("OAuth not configured for provider: discord");
  });

  it("Slack env vars not configured → 400", async () => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    const { app } = await createApp(TEST_USER);
    const res = await app.request("/api/channel-oauth/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "slack" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("OAuth not configured for provider: slack");
  });
});

// ---------------------------------------------------------------------------
// E2E: Token storage and isolation
// ---------------------------------------------------------------------------

describe("E2E: channel OAuth — token storage and isolation", () => {
  let savedSlackClientId: string | undefined;
  let savedSlackClientSecret: string | undefined;

  beforeEach(() => {
    savedSlackClientId = process.env.SLACK_CLIENT_ID;
    savedSlackClientSecret = process.env.SLACK_CLIENT_SECRET;
    process.env.SLACK_CLIENT_ID = "slack-client-id";
    process.env.SLACK_CLIENT_SECRET = "slack-client-secret";
  });

  afterEach(() => {
    if (savedSlackClientId !== undefined) process.env.SLACK_CLIENT_ID = savedSlackClientId;
    else delete process.env.SLACK_CLIENT_ID;
    if (savedSlackClientSecret !== undefined) process.env.SLACK_CLIENT_SECRET = savedSlackClientSecret;
    else delete process.env.SLACK_CLIENT_SECRET;
  });

  it("poll before callback completes → pending status", async () => {
    const { app } = await createApp(TEST_USER);

    const initiateRes = await app.request("/api/channel-oauth/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "slack" }),
    });
    const { state } = (await initiateRes.json()) as { state: string; authorizeUrl: string };

    // Poll before callback — should return pending
    const pollRes = await app.request(`/api/channel-oauth/poll?state=${state}`);
    expect(pollRes.status).toBe(200);
    const body = await pollRes.json();
    expect(body).toMatchObject({ status: "pending" });
  });

  it("token is scoped to the user who initiated the flow (different user cannot retrieve it)", async () => {
    const user1: AuthUser = { id: "user-1", roles: ["user"] };
    const user2: AuthUser = { id: "user-2", roles: ["user"] };

    // Create a shared DB/repo so both users interact with the same store
    const { db, pool } = await createTestDb();
    activePools.push(pool);
    const repo = new DrizzleOAuthStateRepository(db);

    async function makeApp(user: AuthUser) {
      const routes = createChannelOAuthRoutes(repo);
      const app = new Hono<AuthEnv>();
      app.use("/*", async (c, next) => {
        c.set("user", user);
        c.set("authMethod", "session");
        return next();
      });
      app.route("/api/channel-oauth", routes);
      return app;
    }

    const app1 = await makeApp(user1);
    const app2 = await makeApp(user2);

    // User 1 initiates
    const initiateRes = await app1.request("/api/channel-oauth/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "slack" }),
    });
    const { state } = (await initiateRes.json()) as { state: string; authorizeUrl: string };

    // Mock token exchange for callback
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue(""),
        json: vi.fn().mockResolvedValue({
          ok: true,
          access_token: "xoxb-user1-token",
        }),
      }),
    );

    await app1.request(`/api/channel-oauth/callback?code=user1-code&state=${state}`);

    // User 2 tries to poll for user 1's token — should return pending (not the token)
    const pollRes = await app2.request(`/api/channel-oauth/poll?state=${state}`);
    expect(pollRes.status).toBe(200);
    const body = await pollRes.json();
    // consumeCompleted filters by userId, so user2 gets pending
    expect(body).toMatchObject({ status: "pending" });

    // User 1 polls — should get the token
    const pollRes1 = await app1.request(`/api/channel-oauth/poll?state=${state}`);
    expect(pollRes1.status).toBe(200);
    const body1 = (await pollRes1.json()) as { status: string; token?: string };
    expect(body1.status).toBe("completed");
    expect(body1.token).toBe("xoxb-user1-token");
  });

  it("missing state param in poll → 400", async () => {
    const { app } = await createApp(TEST_USER);
    const res = await app.request("/api/channel-oauth/poll");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Missing state parameter" });
  });

  it("postMessage targets UI_ORIGIN, not window.location.origin", async () => {
    const savedOrigin = process.env.UI_ORIGIN;
    process.env.UI_ORIGIN = "https://app.wopr.network";

    try {
      const { app } = await createApp(TEST_USER);
      const res = await app.request("/api/channel-oauth/callback?error=test");
      const html = await res.text();
      expect(html).toContain("https://app.wopr.network");
      expect(html).not.toContain("window.location.origin");
    } finally {
      if (savedOrigin !== undefined) process.env.UI_ORIGIN = savedOrigin;
      else delete process.env.UI_ORIGIN;
    }
  });

  it("multiple concurrent OAuth flows do not interfere", async () => {
    const { app } = await createApp(TEST_USER);

    // Initiate two flows in parallel
    const [res1, res2] = await Promise.all([
      app.request("/api/channel-oauth/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "slack" }),
      }),
      app.request("/api/channel-oauth/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "slack" }),
      }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const { state: state1 } = (await res1.json()) as { state: string; authorizeUrl: string };
    const { state: state2 } = (await res2.json()) as { state: string; authorizeUrl: string };

    // States must be unique
    expect(state1).not.toBe(state2);

    // Complete flow 1 only
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue(""),
        json: vi.fn().mockResolvedValue({
          ok: true,
          access_token: "xoxb-flow1-token",
        }),
      }),
    );

    await app.request(`/api/channel-oauth/callback?code=code1&state=${state1}`);

    // Poll flow 1 → completed
    const poll1 = await app.request(`/api/channel-oauth/poll?state=${state1}`);
    const body1 = (await poll1.json()) as { status: string; token?: string };
    expect(body1.status).toBe("completed");
    expect(body1.token).toBe("xoxb-flow1-token");

    // Poll flow 2 (not yet completed) → pending
    const poll2 = await app.request(`/api/channel-oauth/poll?state=${state2}`);
    const body2 = await poll2.json();
    expect(body2).toMatchObject({ status: "pending" });
  });
});
