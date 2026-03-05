import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateVerificationToken,
  getUserEmail,
  initVerificationSchema,
  isEmailVerified,
  verifyToken,
} from "../../src/email/verification.js";
import {
  requireEmailVerified,
  type IEmailVerifier,
} from "../../src/email/require-verified.js";
import { Hono } from "hono";
import { initBetterAuthSchema, pgliteAsPool } from "../../src/test/pglite-helpers.js";

const BASE_URL = "http://localhost:3100";
const AUTH_PATH = "/api/auth";
const SESSION_COOKIE = "better-auth.session_token";

describe("E2E: email verification — register → verify email → login verified", () => {
  let pg: PGlite;
  let pool: ReturnType<typeof pgliteAsPool>;
  let auth: ReturnType<typeof betterAuth>;

  const TEST_EMAIL = "verify-e2e@test.com";
  const TEST_PASSWORD = "SecurePass123!";
  const TEST_NAME = "Verify User";

  beforeEach(async () => {
    pg = new PGlite();
    pool = pgliteAsPool(pg);
    auth = betterAuth({
      database: pool,
      secret: "test-secret-for-email-verify-e2e",
      baseURL: BASE_URL,
      basePath: AUTH_PATH,
      emailAndPassword: { enabled: true },
      trustedOrigins: [BASE_URL],
      advanced: { cookiePrefix: "better-auth" },
    });
    await initBetterAuthSchema(pg);
    await initVerificationSchema(pool);
  });

  afterEach(async () => {
    await pg.close();
  });

  function extractSessionCookie(res: Response): string | null {
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) return null;
    const match = setCookie.match(
      new RegExp(`${SESSION_COOKIE.replace(".", "\\.")}=([^;]+)`),
    );
    return match ? match[1] : null;
  }

  function authRequest(
    path: string,
    opts: { method?: string; body?: unknown; cookie?: string } = {},
  ): Request {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (opts.cookie) {
      headers.Cookie = `${SESSION_COOKIE}=${opts.cookie}`;
    }
    return new Request(`${BASE_URL}${AUTH_PATH}${path}`, {
      method: opts.method ?? "POST",
      headers,
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
  }

  /** Register a user and return their user ID */
  async function registerUser(
    email: string,
    password: string,
    name: string,
  ): Promise<string> {
    const res = await auth.handler(
      authRequest("/sign-up/email", { body: { email, password, name } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toBeDefined();
    return body.user.id;
  }

  // =========================================================================
  // TEST 1: Full lifecycle — register → verify → login → emailVerified = true
  // =========================================================================

  it("register → generate token → verify → login shows verified user", async () => {
    // Step 1: Register
    const userId = await registerUser(TEST_EMAIL, TEST_PASSWORD, TEST_NAME);

    // Step 2: User starts unverified
    expect(await isEmailVerified(pool, userId)).toBe(false);

    // Step 3: Generate verification token
    const { token } = await generateVerificationToken(pool, userId);
    expect(token).toHaveLength(64);

    // Step 4: Verify the token
    const result = await verifyToken(pool, token);
    expect(result).toEqual({ userId, email: TEST_EMAIL });

    // Step 5: Confirm user is now verified in DB
    expect(await isEmailVerified(pool, userId)).toBe(true);

    // Step 5b: Assert both email_verified (our column) and "emailVerified" (better-auth column) are consistent.
    const { rows: userRows } = await pg.query(
      `SELECT email_verified, "emailVerified" FROM "user" WHERE id = $1`,
      [userId],
    );
    expect(userRows[0].email_verified).toBe(true);
    expect(userRows[0].emailVerified).toBe(true);

    // Step 6: Login — should succeed and return session
    const loginRes = await auth.handler(
      authRequest("/sign-in/email", {
        body: { email: TEST_EMAIL, password: TEST_PASSWORD },
      }),
    );
    expect(loginRes.status).toBe(200);
    const sessionToken = extractSessionCookie(loginRes);
    expect(sessionToken).not.toBeNull();

    // Step 7: Session check returns the user
    const sessionRes = await auth.handler(
      authRequest("/get-session", { method: "GET", cookie: sessionToken! }),
    );
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.user).toBeDefined();
    expect(sessionBody.user.email).toBe(TEST_EMAIL);
  });

  // =========================================================================
  // TEST 2: Expired verification token returns null
  // =========================================================================

  it("expired token → verifyToken returns null", async () => {
    const userId = await registerUser(
      "expired@test.com",
      TEST_PASSWORD,
      "Expired",
    );
    const { token } = await generateVerificationToken(pool, userId);

    // Manually expire the token
    await pg.query(
      `UPDATE "user" SET verification_expires = $1 WHERE id = $2`,
      [new Date(Date.now() - 1000).toISOString(), userId],
    );

    const result = await verifyToken(pool, token);
    expect(result).toBeNull();
    expect(await isEmailVerified(pool, userId)).toBe(false);
  });

  // =========================================================================
  // TEST 3: Re-verifying already-verified email returns null (idempotent)
  // =========================================================================

  it("re-verification of already-verified user returns null", async () => {
    const userId = await registerUser(
      "reverify@test.com",
      TEST_PASSWORD,
      "ReVerify",
    );
    const { token } = await generateVerificationToken(pool, userId);

    // First verify succeeds
    const first = await verifyToken(pool, token);
    expect(first).not.toBeNull();
    expect(await isEmailVerified(pool, userId)).toBe(true);

    // Generate new token and try again — user already verified
    const { token: token2 } = await generateVerificationToken(pool, userId);
    const second = await verifyToken(pool, token2);
    expect(second).toBeNull();
  });

  // =========================================================================
  // TEST 4: Invalid/tampered token rejected
  // =========================================================================

  it("invalid token → verifyToken returns null", async () => {
    // Wrong length
    expect(await verifyToken(pool, "abc")).toBeNull();
    // Right length but doesn't exist
    expect(await verifyToken(pool, "a".repeat(64))).toBeNull();
    // Empty
    expect(await verifyToken(pool, "")).toBeNull();
  });

  // =========================================================================
  // TEST 5: Login before verification — allowed (policy: middleware gates)
  // =========================================================================

  it("login before verification succeeds (middleware gates protected routes)", async () => {
    await registerUser("unverified@test.com", TEST_PASSWORD, "Unverified");

    // Login without verifying email — better-auth allows it
    const loginRes = await auth.handler(
      authRequest("/sign-in/email", {
        body: { email: "unverified@test.com", password: TEST_PASSWORD },
      }),
    );
    expect(loginRes.status).toBe(200);
    const sessionToken = extractSessionCookie(loginRes);
    expect(sessionToken).not.toBeNull();

    // Session check succeeds
    const sessionRes = await auth.handler(
      authRequest("/get-session", { method: "GET", cookie: sessionToken! }),
    );
    expect(sessionRes.status).toBe(200);
  });

  // =========================================================================
  // TEST 6: requireEmailVerified middleware blocks unverified session users
  // =========================================================================

  it("requireEmailVerified middleware blocks unverified, allows verified", async () => {
    const userId = await registerUser(
      "middleware@test.com",
      TEST_PASSWORD,
      "MW User",
    );

    // Build a mini Hono app with the middleware
    const verifier: IEmailVerifier = {
      isVerified: (id: string) => isEmailVerified(pool, id),
    };
    const app = new Hono();
    app.use("/protected/*", async (c, next) => {
      c.set("authMethod", "session");
      c.set("user", { id: userId, roles: ["user"] });
      return next();
    });
    app.use("/protected/*", requireEmailVerified(verifier));
    app.post("/protected/action", (c) => c.json({ ok: true }));

    // Unverified → 403
    const blockedRes = await app.request("/protected/action", {
      method: "POST",
    });
    expect(blockedRes.status).toBe(403);
    const blockedBody = await blockedRes.json();
    expect(blockedBody.code).toBe("EMAIL_NOT_VERIFIED");

    // Verify the user
    const { token } = await generateVerificationToken(pool, userId);
    await verifyToken(pool, token);

    // Verified → 200
    const allowedRes = await app.request("/protected/action", {
      method: "POST",
    });
    expect(allowedRes.status).toBe(200);
    const allowedBody = await allowedRes.json();
    expect(allowedBody.ok).toBe(true);
  });

  // =========================================================================
  // TEST 7: Billing email can be sent to verified address
  // =========================================================================

  it("billing email sends to verified user address", async () => {
    const userId = await registerUser(
      "billing@test.com",
      TEST_PASSWORD,
      "Billing",
    );

    // Verify the user
    const { token } = await generateVerificationToken(pool, userId);
    const result = await verifyToken(pool, token);
    expect(result).not.toBeNull();
    expect(result!.email).toBe("billing@test.com");

    // Confirm the verified email matches what we'd send billing to
    const email = await getUserEmail(pool, userId);
    expect(email).toBe("billing@test.com");
    expect(await isEmailVerified(pool, userId)).toBe(true);
  });
});
