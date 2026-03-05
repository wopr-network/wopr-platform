import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
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

/**
 * Create the better-auth base schema tables in PGlite.
 * Replaces getMigrations() which requires a Kysely adapter not compatible with PGlite.
 */
async function initBetterAuthSchema(pg: PGlite): Promise<void> {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS "user" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "email" text NOT NULL UNIQUE,
      "emailVerified" boolean NOT NULL DEFAULT false,
      "image" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "token" text NOT NULL UNIQUE,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "ipAddress" text,
      "userAgent" text,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    )
  `);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS "account" (
      "id" text PRIMARY KEY NOT NULL,
      "accountId" text NOT NULL,
      "providerId" text NOT NULL,
      "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" timestamptz,
      "refreshTokenExpiresAt" timestamptz,
      "scope" text,
      "password" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS "verification" (
      "id" text PRIMARY KEY NOT NULL,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz,
      "updatedAt" timestamptz
    )
  `);
}

const BASE_URL = "http://localhost:3100";
const AUTH_PATH = "/api/auth";

describe("E2E: auth flow — register → login → session → logout", () => {
  let pg: PGlite;
  let auth: ReturnType<typeof betterAuth>;

  beforeEach(async () => {
    pg = new PGlite();
    auth = betterAuth({
      database: pgliteAsPool(pg),
      secret: "test-secret-for-auth-flow-e2e",
      baseURL: BASE_URL,
      basePath: AUTH_PATH,
      emailAndPassword: { enabled: true },
      trustedOrigins: [BASE_URL],
    });
    await initBetterAuthSchema(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  /** Helper: extract session cookie from Set-Cookie header */
  function extractSessionCookie(res: Response): string | null {
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) return null;
    // better-auth sets "better-auth.session_token=<value>; ..."
    const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
    return match ? match[1] : null;
  }

  /** Helper: build request with JSON body */
  function authRequest(
    path: string,
    opts: { method?: string; body?: unknown; cookie?: string } = {},
  ): Request {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.cookie) {
      headers.Cookie = `better-auth.session_token=${opts.cookie}`;
    }
    return new Request(`${BASE_URL}${AUTH_PATH}${path}`, {
      method: opts.method ?? "POST",
      headers,
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
  }

  const TEST_EMAIL = "e2e@test.com";
  const TEST_PASSWORD = "SecurePass123!";
  const TEST_NAME = "E2E User";
  const WRONG_PASSWORD = "WrongPass999!xx";

  // =========================================================================
  // TEST 1: Full auth lifecycle
  // =========================================================================

  it("register → login → session → API call → logout → 401", async () => {
    // Step 1: Register
    const registerRes = await auth.handler(
      authRequest("/sign-up/email", {
        body: { email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME },
      }),
    );
    expect(registerRes.status).toBe(200);
    const registerBody = await registerRes.json();
    expect(registerBody.user).toBeDefined();
    expect(registerBody.user.email).toBe(TEST_EMAIL);

    // Step 2: Login
    const loginRes = await auth.handler(
      authRequest("/sign-in/email", {
        body: { email: TEST_EMAIL, password: TEST_PASSWORD },
      }),
    );
    expect(loginRes.status).toBe(200);
    const sessionToken = extractSessionCookie(loginRes);
    expect(sessionToken).not.toBeNull();
    expect(sessionToken).not.toBe("");

    // Step 3: Authenticated session check — returns user data
    const sessionRes = await auth.handler(
      authRequest("/get-session", { method: "GET", cookie: sessionToken! }),
    );
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.user).toBeDefined();
    expect(sessionBody.user.email).toBe(TEST_EMAIL);
    expect(sessionBody.session).toBeDefined();

    // Step 4: Logout
    const logoutRes = await auth.handler(
      authRequest("/sign-out", { cookie: sessionToken! }),
    );
    expect(logoutRes.status).toBe(200);

    // Step 5: Session check after logout → should fail (no valid session)
    const postLogoutRes = await auth.handler(
      authRequest("/get-session", { method: "GET", cookie: sessionToken! }),
    );
    // better-auth returns 200 with null body, 200 with { user: null }, or 401
    // after logout — assert no valid session is returned.
    if (postLogoutRes.status === 200) {
      const postLogoutText = await postLogoutRes.text();
      if (postLogoutText && postLogoutText !== "null") {
        const postLogoutBody = JSON.parse(postLogoutText);
        expect(postLogoutBody.user).toBeNull();
      }
      // else: null body means no session — pass
    } else {
      expect(postLogoutRes.status).toBe(401);
    }
  });

  // =========================================================================
  // TEST 2: Wrong password → rejection
  // =========================================================================

  it("wrong password → non-200 response", async () => {
    // Register first
    await auth.handler(
      authRequest("/sign-up/email", {
        body: { email: "wrong-pw@test.com", password: TEST_PASSWORD, name: "WP User" },
      }),
    );

    // Login with wrong password
    const res = await auth.handler(
      authRequest("/sign-in/email", {
        body: { email: "wrong-pw@test.com", password: WRONG_PASSWORD },
      }),
    );
    // better-auth returns 401 or 400 for bad credentials
    expect(res.status).not.toBe(200);
  });

  // =========================================================================
  // TEST 3: No session → get-session returns no user
  // =========================================================================

  it("no session cookie → get-session returns no user", async () => {
    const res = await auth.handler(
      authRequest("/get-session", { method: "GET" }),
    );
    // No cookie → no session. better-auth returns 200 with null body, 200 with { user: null }, or 401.
    if (res.status === 200) {
      const text = await res.text();
      if (text && text !== "null") {
        const body = JSON.parse(text);
        expect(body.user).toBeNull();
      }
      // else: null body means no session — pass
    } else {
      expect(res.status).toBe(401);
    }
  });

  // =========================================================================
  // TEST 4: Double logout is idempotent (no 500)
  // =========================================================================

  it("double logout is idempotent — no 500", async () => {
    // Register + login
    await auth.handler(
      authRequest("/sign-up/email", {
        body: { email: "dbl-logout@test.com", password: TEST_PASSWORD, name: "DL User" },
      }),
    );
    const loginRes = await auth.handler(
      authRequest("/sign-in/email", {
        body: { email: "dbl-logout@test.com", password: TEST_PASSWORD },
      }),
    );
    const token = extractSessionCookie(loginRes);
    expect(token).not.toBeNull();

    // First logout
    const logout1 = await auth.handler(authRequest("/sign-out", { cookie: token! }));
    expect(logout1.status).toBe(200);

    // Second logout — same cookie, already invalidated
    const logout2 = await auth.handler(authRequest("/sign-out", { cookie: token! }));
    // Must not be 500 — idempotent
    expect(logout2.status).not.toBe(500);
  });
});
