import { describe, expect, it, vi } from "vitest";
import { createVerifyEmailRoutes } from "../../../src/api/routes/verify-email.js";
import type { ICreditLedger } from "@wopr-network/platform-core";
import type { Pool } from "pg";

// Mock the email verification module
vi.mock("../../../src/email/verification.js", () => ({
  verifyToken: vi.fn(),
}));

// Mock the email client
vi.mock("../../../src/email/client.js", () => ({
  getEmailClient: vi.fn(() => ({
    send: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock the email templates
vi.mock("../../../src/email/templates.js", () => ({
  welcomeTemplate: vi.fn(() => ({
    subject: "Welcome!",
    html: "<p>Welcome</p>",
    text: "Welcome",
  })),
}));

import { verifyToken } from "@wopr-network/platform-core";

const mockVerifyToken = vi.mocked(verifyToken);

function makeLedger(overrides: Partial<ICreditLedger> = {}): ICreditLedger {
  return {
    credit: vi.fn().mockResolvedValue({
      id: "txn-1",
      tenantId: "user-1",
      amount: { toRaw: () => 500_000_000, toCents: () => 500 } as any,
      balanceAfter: { toRaw: () => 500_000_000 } as any,
      type: "signup_grant",
      description: null,
      referenceId: "signup:user-1",
      fundingSource: null,
      attributedUserId: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    }),
    hasReferenceId: vi.fn().mockResolvedValue(false),
    debit: vi.fn(),
    balance: vi.fn().mockResolvedValue({ toRaw: () => 0 } as any),
    history: vi.fn().mockResolvedValue([]),
    tenantsWithBalance: vi.fn().mockResolvedValue([]),
    memberUsage: vi.fn().mockResolvedValue([]),
    expiredCredits: vi.fn().mockResolvedValue([]),
    lifetimeSpend: vi.fn().mockResolvedValue({ toCents: () => 0 }),
    ...overrides,
  };
}

function makePool(): Pool {
  return {} as Pool;
}

async function sendRequest(app: ReturnType<typeof createVerifyEmailRoutes>, token?: string) {
  const url = token ? `/verify?token=${token}` : "/verify";
  const req = new Request(`http://localhost${url}`);
  return app.fetch(req);
}

describe("GET /verify", () => {
  it("redirects with error when token is missing", async () => {
    const ledger = makeLedger();
    const app = createVerifyEmailRoutes({ pool: makePool(), creditLedger: ledger });

    const res = await sendRequest(app);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("status=error&reason=missing_token");
  });

  it("redirects with error when token is invalid", async () => {
    mockVerifyToken.mockResolvedValueOnce(null);
    const ledger = makeLedger();
    const app = createVerifyEmailRoutes({ pool: makePool(), creditLedger: ledger });

    const res = await sendRequest(app, "bad-token");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("status=error&reason=invalid_or_expired");
  });

  it("grants signup credits on first verification", async () => {
    mockVerifyToken.mockResolvedValueOnce({ userId: "user-1", email: "user@example.com" });
    const ledger = makeLedger({ hasReferenceId: vi.fn().mockResolvedValue(false) });
    const app = createVerifyEmailRoutes({ pool: makePool(), creditLedger: ledger });

    const res = await sendRequest(app, "valid-token");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("status=success");
    expect(ledger.credit).toHaveBeenCalledOnce();
    expect(ledger.credit).toHaveBeenCalledWith(
      "user-1",
      expect.anything(),
      "signup_grant",
      "Welcome bonus — $5.00 credit on email verification",
      "signup:user-1",
    );
  });

  it("does NOT grant credits on re-click (idempotent)", async () => {
    mockVerifyToken.mockResolvedValueOnce({ userId: "user-1", email: "user@example.com" });
    // Already granted — hasReferenceId returns true
    const ledger = makeLedger({ hasReferenceId: vi.fn().mockResolvedValue(true) });
    const app = createVerifyEmailRoutes({ pool: makePool(), creditLedger: ledger });

    const res = await sendRequest(app, "valid-token");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("status=success");
    // credit() must NOT be called — idempotency guard prevented it
    expect(ledger.credit).not.toHaveBeenCalled();
  });

  it("still redirects success if credit grant throws", async () => {
    mockVerifyToken.mockResolvedValueOnce({ userId: "user-1", email: "user@example.com" });
    const ledger = makeLedger({
      hasReferenceId: vi.fn().mockRejectedValue(new Error("DB down")),
    });
    const app = createVerifyEmailRoutes({ pool: makePool(), creditLedger: ledger });

    const res = await sendRequest(app, "valid-token");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("status=success");
  });
});
