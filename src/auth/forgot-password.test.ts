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

describe("Forgot password flow (e2e)", () => {
  let pg: PGlite;
  let auth: ReturnType<typeof betterAuth>;
  let capturedResetUrl: string | null;
  let capturedResetToken: string | null;

  beforeEach(async () => {
    pg = new PGlite();
    capturedResetUrl = null;
    capturedResetToken = null;

    auth = betterAuth({
      database: pgliteAsPool(pg),
      secret: "test-secret-for-forgot-password-e2e",
      baseURL: "http://localhost:3100",
      basePath: "/api/auth",
      emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({ url, token }: { user: unknown; url: string; token: string }) => {
          capturedResetUrl = url;
          capturedResetToken = token;
        },
      },
      trustedOrigins: ["http://localhost:3100"],
      advanced: {
        // Force origin validation even in test environment (better-auth disables it by default
        // when NODE_ENV=test). We need this enabled to verify the redirectTo allowlist check.
        disableOriginCheck: false,
      },
    });

    // Initialize the Better Auth schema (creates tables: user, session, account, verification)
    await initBetterAuthSchema(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  /** Helper: create a user via Better Auth's API */
  async function createTestUser(email: string, password: string, name = "Test User") {
    const res = await auth.handler(
      new Request("http://localhost:3100/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      }),
    );
    expect(res.status).toBe(200);
    return res;
  }

  /** Helper: sign in and verify credentials work */
  async function signIn(email: string, password: string) {
    return auth.handler(
      new Request("http://localhost:3100/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  it("full reset flow: request → token → reset → login with new password", async () => {
    const email = "user@test.com";
    const oldPassword = "OldPassword123!";
    const newPassword = "NewSecurePassword456!";

    // Step 1: Create a user
    await createTestUser(email, oldPassword);

    // Step 2: Verify old password works
    const loginRes = await signIn(email, oldPassword);
    expect(loginRes.status).toBe(200);

    // Step 3: Request password reset
    const resetReqRes = await auth.handler(
      new Request("http://localhost:3100/api/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, redirectTo: "/reset-password" }),
      }),
    );
    expect(resetReqRes.status).toBe(200);
    const resetReqBody = (await resetReqRes.json()) as { status: boolean };
    expect(resetReqBody.status).toBe(true);

    // Step 4: Verify sendResetPassword callback was invoked
    expect(capturedResetUrl).not.toBeNull();
    expect(capturedResetToken).not.toBeNull();
    expect(capturedResetUrl).toContain(capturedResetToken);

    // Step 5: Reset password using the token
    const resetRes = await auth.handler(
      new Request("http://localhost:3100/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword, token: capturedResetToken }),
      }),
    );
    expect(resetRes.status).toBe(200);
    const resetBody = (await resetRes.json()) as { status: boolean };
    expect(resetBody.status).toBe(true);

    // Step 6: Old password no longer works
    const oldLoginRes = await signIn(email, oldPassword);
    expect(oldLoginRes.status).not.toBe(200);

    // Step 7: New password works
    const newLoginRes = await signIn(email, newPassword);
    expect(newLoginRes.status).toBe(200);
  }, 30000);

  it("reset token is single-use", async () => {
    const email = "single-use@test.com";
    await createTestUser(email, "Password123!");

    // Request reset
    await auth.handler(
      new Request("http://localhost:3100/api/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, redirectTo: "/reset-password" }),
      }),
    );

    // capturedResetToken is set by sendResetPassword callback
    expect(capturedResetToken).not.toBeNull();
    const token = capturedResetToken as string;

    // First reset — should succeed
    const firstRes = await auth.handler(
      new Request("http://localhost:3100/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "FirstReset123!", token }),
      }),
    );
    expect(firstRes.status).toBe(200);

    // Second reset with same token — should fail
    const secondRes = await auth.handler(
      new Request("http://localhost:3100/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "SecondReset456!", token }),
      }),
    );
    expect(secondRes.status).not.toBe(200);
  });

  it("expired token is rejected", async () => {
    const email = "expired@test.com";
    await createTestUser(email, "Password123!");

    // Request reset
    await auth.handler(
      new Request("http://localhost:3100/api/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, redirectTo: "/reset-password" }),
      }),
    );

    // capturedResetToken is set by sendResetPassword callback
    expect(capturedResetToken).not.toBeNull();
    const token = capturedResetToken as string;

    // Manually expire the token by updating the verification table
    // Better Auth stores verifications in a "verification" table
    const { rows } = await pg.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const verificationTable = rows.find((r) => r.tablename === "verification");
    if (verificationTable) {
      await pg.query(`UPDATE "verification" SET "expiresAt" = $1 WHERE "identifier" = $2`, [
        new Date(Date.now() - 60_000).toISOString(),
        `reset-password:${token}`,
      ]);
    }

    // Attempt reset with expired token
    const res = await auth.handler(
      new Request("http://localhost:3100/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "NewPassword123!", token }),
      }),
    );
    expect(res.status).not.toBe(200);
  });

  it("request for non-existent email returns success (no user enumeration)", async () => {
    const res = await auth.handler(
      new Request("http://localhost:3100/api/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@test.com", redirectTo: "/reset-password" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: boolean };
    expect(body.status).toBe(true);

    // No email should have been sent
    expect(capturedResetUrl).toBeNull();
    expect(capturedResetToken).toBeNull();
  });

  it("rejects absolute-URL redirectTo (open-redirect prevention)", async () => {
    const email = "redirect-test@test.com";
    await createTestUser(email, "Password123!");

    const res = await auth.handler(
      new Request("http://localhost:3100/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3100",
        },
        body: JSON.stringify({
          email,
          redirectTo: "https://evil.com/steal-token",
        }),
      }),
    );
    // better-auth's originCheckMiddleware rejects untrusted absolute URLs with 403
    expect(res.status).toBe(403);

    // No reset email should have been sent
    expect(capturedResetUrl).toBeNull();
    expect(capturedResetToken).toBeNull();
  });

  it("rejects protocol-relative redirectTo", async () => {
    const email = "proto-rel@test.com";
    await createTestUser(email, "Password123!");

    const res = await auth.handler(
      new Request("http://localhost:3100/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3100",
        },
        body: JSON.stringify({
          email,
          redirectTo: "//evil.com/steal-token",
        }),
      }),
    );
    // Protocol-relative URLs resolve to a different origin — must be rejected
    expect(res.status).toBe(403);
    expect(capturedResetUrl).toBeNull();
  });

  it("accepts valid relative-path redirectTo", async () => {
    const email = "valid-redirect@test.com";
    await createTestUser(email, "Password123!");

    const res = await auth.handler(
      new Request("http://localhost:3100/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3100",
        },
        body: JSON.stringify({
          email,
          redirectTo: "/reset-password",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: boolean };
    expect(body.status).toBe(true);

    // Reset email should have been sent with the token
    expect(capturedResetUrl).not.toBeNull();
    expect(capturedResetToken).not.toBeNull();
  });

  it("rejects javascript: scheme redirectTo", async () => {
    const email = "js-scheme@test.com";
    await createTestUser(email, "Password123!");

    const res = await auth.handler(
      new Request("http://localhost:3100/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3100",
        },
        body: JSON.stringify({
          email,
          redirectTo: "javascript:alert(1)",
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(capturedResetUrl).toBeNull();
  });
});
