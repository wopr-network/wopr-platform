import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditAdjustmentStore } from "../admin/credits/adjustment-store.js";
import { initCreditAdjustmentSchema } from "../admin/credits/schema.js";
import { createVerifyEmailRoutes } from "../api/routes/verify-email.js";
import { generateVerificationToken, initVerificationSchema } from "./verification.js";

// Mock the email client so we don't actually send emails
const mockSend = vi.fn().mockResolvedValue({ id: "email-1", success: true });
vi.mock("./client.js", () => ({
  getEmailClient: () => ({ send: mockSend }),
  EmailClient: class {},
  resetEmailClient: vi.fn(),
  setEmailClient: vi.fn(),
}));

vi.mock("../config/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("verify-email route", () => {
  let authDb: Database.Database;
  let creditsDb: Database.Database;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();

    authDb = new Database(":memory:");
    authDb.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        createdAt TEXT
      )
    `);
    initVerificationSchema(authDb);
    authDb.prepare("INSERT INTO user (id, email, name) VALUES (?, ?, ?)").run("user-1", "alice@test.com", "Alice");

    creditsDb = new Database(":memory:");
    initCreditAdjustmentSchema(creditsDb);

    const routes = createVerifyEmailRoutes({ authDb, creditsDb });
    app = new Hono();
    app.route("/auth", routes);
  });

  afterEach(() => {
    authDb.close();
    creditsDb.close();
  });

  it("should redirect with error when no token is provided", async () => {
    const res = await app.request("/auth/verify");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("status=error");
    expect(res.headers.get("Location")).toContain("reason=missing_token");
  });

  it("should redirect with error for invalid token", async () => {
    const res = await app.request(`/auth/verify?token=${"a".repeat(64)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("status=error");
    expect(res.headers.get("Location")).toContain("reason=invalid_or_expired");
  });

  it("should verify valid token, grant credit, and send welcome email", async () => {
    const { token } = generateVerificationToken(authDb, "user-1");

    const res = await app.request(`/auth/verify?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("status=success");

    // Check user is verified
    const row = authDb.prepare("SELECT email_verified FROM user WHERE id = ?").get("user-1") as {
      email_verified: number;
    };
    expect(row.email_verified).toBe(1);

    // Check credit was granted ($5 = 500 cents)
    const store = new CreditAdjustmentStore(creditsDb);
    expect(store.getBalance("user-1")).toBe(500);

    // Check welcome email was sent
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alice@test.com",
        templateName: "welcome",
      }),
    );
  });

  it("should redirect with error for expired token", async () => {
    const { token } = generateVerificationToken(authDb, "user-1");
    authDb
      .prepare("UPDATE user SET verification_expires = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), "user-1");

    const res = await app.request(`/auth/verify?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("reason=invalid_or_expired");
  });

  it("should not grant credit twice on repeated verification", async () => {
    const { token: token1 } = generateVerificationToken(authDb, "user-1");
    await app.request(`/auth/verify?token=${token1}`);

    // Generate a new token and try to verify again (won't work because already verified)
    authDb
      .prepare("UPDATE user SET email_verified = 0, verification_token = 'x', verification_expires = ?")
      .run(new Date(Date.now() + 86400000).toISOString());
    // The previous token was consumed; new one is 'x' which is wrong length
    const res = await app.request("/auth/verify?token=x");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("reason=invalid_or_expired");

    // Only one credit grant
    const store = new CreditAdjustmentStore(creditsDb);
    expect(store.getBalance("user-1")).toBe(500);
  });

  it("should still verify even if welcome email fails", async () => {
    mockSend.mockRejectedValueOnce(new Error("SMTP failure"));
    const { token } = generateVerificationToken(authDb, "user-1");

    const res = await app.request(`/auth/verify?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("status=success");

    const row = authDb.prepare("SELECT email_verified FROM user WHERE id = ?").get("user-1") as {
      email_verified: number;
    };
    expect(row.email_verified).toBe(1);
  });
});
