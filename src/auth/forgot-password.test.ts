import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("Forgot password flow (e2e)", () => {
  let db: Database.Database;
  let auth: ReturnType<typeof betterAuth>;
  let capturedResetUrl: string | null;
  let capturedResetToken: string | null;

  beforeEach(async () => {
    db = new Database(":memory:");
    capturedResetUrl = null;
    capturedResetToken = null;

    auth = betterAuth({
      database: db,
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
    });

    // Initialize the Better Auth schema (creates tables: user, session, account, verification)
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
  });

  afterEach(() => {
    db.close();
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
  });

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
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const verificationTable = rows.find((r) => r.name === "verification");
    if (verificationTable) {
      db.prepare("UPDATE verification SET expiresAt = ? WHERE identifier = ?").run(
        new Date(Date.now() - 60_000).toISOString(),
        `reset-password:${token}`,
      );
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
});
