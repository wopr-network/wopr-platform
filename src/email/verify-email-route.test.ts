import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifyEmailRoutes } from "../api/routes/verify-email.js";
import type { ICreditLedger } from "../monetization/credits/credit-ledger.js";
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
  let authDb: import("better-sqlite3").Database;
  let creditLedger: ICreditLedger;
  let app: Hono;

  beforeEach(async () => {
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

    const balances = new Map<string, number>();
    creditLedger = {
      credit(tenantId, amountCents) {
        balances.set(tenantId, (balances.get(tenantId) ?? 0) + amountCents);
        return {
          id: "tx-1",
          tenantId,
          amountCents,
          balanceAfterCents: balances.get(tenantId)!,
          type: "signup_grant",
          description: null,
          referenceId: null,
          fundingSource: null,
          createdAt: new Date().toISOString(),
        };
      },
      debit(tenantId, amountCents) {
        balances.set(tenantId, (balances.get(tenantId) ?? 0) - amountCents);
        return {
          id: "tx-2",
          tenantId,
          amountCents: -amountCents,
          balanceAfterCents: balances.get(tenantId)!,
          type: "correction",
          description: null,
          referenceId: null,
          fundingSource: null,
          createdAt: new Date().toISOString(),
        };
      },
      balance(tenantId) {
        return balances.get(tenantId) ?? 0;
      },
      hasReferenceId() {
        return false;
      },
      history() {
        return [];
      },
      tenantsWithBalance() {
        return [];
      },
    };

    const routes = createVerifyEmailRoutes({ authDb, creditLedger });
    app = new Hono();
    app.route("/auth", routes);
  });

  afterEach(() => {
    authDb.close();
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
    expect(creditLedger.balance("user-1")).toBe(500);

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
    expect(creditLedger.balance("user-1")).toBe(500);
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

  it("should still verify and redirect to success even if credit grant throws", async () => {
    // Make the ledger throw to simulate a credit grant failure
    const throwingLedger: ICreditLedger = {
      credit() {
        throw new Error("simulated credit failure");
      },
      debit() {
        throw new Error("simulated debit failure");
      },
      balance() {
        return 0;
      },
      hasReferenceId() {
        return false;
      },
      history() {
        return [];
      },
      tenantsWithBalance() {
        return [];
      },
    };
    const routes2 = createVerifyEmailRoutes({ authDb, creditLedger: throwingLedger });
    const app2 = new Hono();
    app2.route("/auth", routes2);

    const { token } = generateVerificationToken(authDb, "user-1");
    const res = await app2.request(`/auth/verify?token=${token}`);

    // Verification should still succeed despite the credit grant failure
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("status=success");
  });
});
