import type { ICreditLedger } from "@wopr-network/platform-core/credits";
import type { EmailClient } from "@wopr-network/platform-core/email/client";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock verifyToken before importing the route — use importOriginal to preserve
// other exports (welcomeTemplate, etc.) that the route handler uses at runtime.
vi.mock("@wopr-network/platform-core/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wopr-network/platform-core/email")>();
  return { ...actual, verifyToken: vi.fn() };
});

// Mock getEmailClient before importing the route
vi.mock("@wopr-network/platform-core/email/client", () => ({
  getEmailClient: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({ id: "mock-email-id", success: true }),
  })),
}));

import { verifyToken } from "@wopr-network/platform-core/email";
import { getEmailClient } from "@wopr-network/platform-core/email/client";
import { createVerifyEmailRoutes } from "./verify-email.js";

const mockedVerifyToken = vi.mocked(verifyToken);
const mockedGetEmailClient = vi.mocked(getEmailClient);

const UI = "http://localhost:3001";

function mockEmailClient(sendImpl: ReturnType<typeof vi.fn>): EmailClient {
  return { send: sendImpl } as unknown as EmailClient;
}

function makeApp() {
  const pool = {} as Pool;
  const creditLedger = {
    credit: vi.fn().mockResolvedValue({
      id: "tx-1",
      tenantId: "user-1",
      amount: { toCents: () => 500 },
      balanceAfter: { toCents: () => 500 },
      type: "signup_grant",
      description: "Signup verification credit",
      referenceId: null,
      fundingSource: null,
      attributedUserId: null,
      createdAt: new Date().toISOString(),
    }),
    debit: vi.fn(),
    balance: vi.fn(),
    hasReferenceId: vi.fn(),
    history: vi.fn(),
    tenantsWithBalance: vi.fn(),
    memberUsage: vi.fn(),
    lifetimeSpend: vi.fn(),
  } as unknown as ICreditLedger;
  const app = createVerifyEmailRoutes({ pool, creditLedger });
  return { app, pool, creditLedger: creditLedger as unknown as { credit: ReturnType<typeof vi.fn> } };
}

describe("verify-email route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset getEmailClient mock to default success behavior
    mockedGetEmailClient.mockReturnValue(
      mockEmailClient(vi.fn().mockResolvedValue({ id: "mock-email-id", success: true })),
    );
  });

  it("valid token -> marks email verified, grants credit, redirects with status=success", async () => {
    mockedVerifyToken.mockResolvedValue({ userId: "user-1", email: "test@example.com" });
    const { app, creditLedger } = makeApp();

    const res = await app.request(`/verify?token=${"a".repeat(64)}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${UI}/auth/verify?status=success`);
    expect(mockedVerifyToken).toHaveBeenCalledOnce();
    expect(creditLedger.credit).toHaveBeenCalledOnce();
  });

  it("expired token -> redirects with reason=invalid_or_expired", async () => {
    mockedVerifyToken.mockResolvedValue(null);
    const { app } = makeApp();

    const res = await app.request(`/verify?token=${"b".repeat(64)}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${UI}/auth/verify?status=error&reason=invalid_or_expired`);
  });

  it("already-used token -> redirects with reason=invalid_or_expired", async () => {
    // verifyToken returns null for already-verified users
    mockedVerifyToken.mockResolvedValue(null);
    const { app } = makeApp();

    const res = await app.request(`/verify?token=${"c".repeat(64)}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${UI}/auth/verify?status=error&reason=invalid_or_expired`);
  });

  it("token for non-existent user -> redirects with reason=invalid_or_expired", async () => {
    // verifyToken returns null when no row matches the token
    mockedVerifyToken.mockResolvedValue(null);
    const { app } = makeApp();

    const res = await app.request(`/verify?token=${"d".repeat(64)}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${UI}/auth/verify?status=error&reason=invalid_or_expired`);
  });

  it("missing token param -> redirects with reason=missing_token", async () => {
    const { app } = makeApp();

    const res = await app.request("/verify");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${UI}/auth/verify?status=error&reason=missing_token`);
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("empty token param -> redirects with reason=missing_token", async () => {
    const { app } = makeApp();

    const res = await app.request("/verify?token=");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${UI}/auth/verify?status=error&reason=missing_token`);
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("credit grant failure does not block verification", async () => {
    mockedVerifyToken.mockResolvedValue({ userId: "user-1", email: "test@example.com" });
    const { app, creditLedger } = makeApp();
    creditLedger.credit.mockRejectedValue(new Error("DB down"));

    const res = await app.request(`/verify?token=${"e".repeat(64)}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${UI}/auth/verify?status=success`);
  });

  it("welcome email failure does not block verification", async () => {
    mockedVerifyToken.mockResolvedValue({ userId: "user-1", email: "test@example.com" });
    mockedGetEmailClient.mockReturnValue(mockEmailClient(vi.fn().mockRejectedValue(new Error("SMTP down"))));
    const { app } = makeApp();

    const res = await app.request(`/verify?token=${"f".repeat(64)}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${UI}/auth/verify?status=success`);
  });
});
