import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { creditBalanceCheck, debitCredits, type CreditGateDeps } from "../../src/gateway/credit-gate.js";
import type { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import type { GatewayAuthEnv } from "../../src/gateway/service-key-auth.js";
import type { GatewayTenant } from "../../src/gateway/types.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const TENANT: GatewayTenant = {
  id: "tenant-credit-test",
  spendLimits: { maxSpendPerHour: 100, maxSpendPerMonth: 1000 },
};

class StubCreditLedger implements CreditLedger {
  private balances = new Map<string, number>();

  constructor(initialBalance: number) {
    this.balances.set(TENANT.id, initialBalance);
  }

  balance(tenantId: string): number {
    return this.balances.get(tenantId) ?? 0;
  }

  credit(tenantId: string, cents: number): void {
    const current = this.balances.get(tenantId) ?? 0;
    this.balances.set(tenantId, current + cents);
  }

  debit(tenantId: string, cents: number): void {
    const current = this.balances.get(tenantId) ?? 0;
    this.balances.set(tenantId, current - cents);
  }

  transactions(): Array<{ tenantId: string; amountCents: number; type: string; description: string; timestamp: number }> {
    return [];
  }
}

function makeTestApp(ledger: CreditLedger): Hono<GatewayAuthEnv> {
  const app = new Hono<GatewayAuthEnv>();

  // Mock middleware to set gatewayTenant
  app.use("*", async (c, next) => {
    c.set("gatewayTenant", TENANT);
    return next();
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("creditBalanceCheck", () => {
  it("returns null when credit ledger is not configured", async () => {
    const app = makeTestApp(new StubCreditLedger(1000));
    const c = app.request("/", { method: "GET" }) as unknown as Parameters<typeof creditBalanceCheck>[0];
    const deps: CreditGateDeps = { topUpUrl: "/credits" };

    const result = await creditBalanceCheck(c, deps, 100);
    expect(result).toBeNull();
  });

  it("returns null when balance is sufficient", async () => {
    const ledger = new StubCreditLedger(1000);
    const app = makeTestApp(ledger);

    const deps: CreditGateDeps = {
      creditLedger: ledger,
      topUpUrl: "/credits",
    };

    app.get("/check-sufficient", async (c) => {
      const err = await creditBalanceCheck(c, deps, 500);
      if (err) {
        return c.json({ error: err }, 402);
      }
      return c.json({ ok: true });
    });

    const res = await app.request("/check-sufficient", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("returns error object when balance is insufficient", async () => {
    const ledger = new StubCreditLedger(100); // Only 100 cents
    const app = makeTestApp(ledger);

    const deps: CreditGateDeps = {
      creditLedger: ledger,
      topUpUrl: "/credits",
    };

    app.get("/check-insufficient", async (c) => {
      const err = await creditBalanceCheck(c, deps, 500); // Need 500 cents
      if (err) {
        return c.json({ error: err }, 402);
      }
      return c.json({ ok: true });
    });

    const res = await app.request("/check-insufficient", { method: "GET" });
    expect(res.status).toBe(402);

    const body = (await res.json()) as {
      error: {
        message: string;
        type: string;
        code: string;
        needsCredits: boolean;
        topUpUrl: string;
        currentBalanceCents: number;
        requiredCents: number;
      };
    };

    expect(body.error.message).toContain("Insufficient credits");
    expect(body.error.type).toBe("billing_error");
    expect(body.error.code).toBe("insufficient_credits");
    expect(body.error.needsCredits).toBe(true);
    expect(body.error.topUpUrl).toBe("/credits");
    expect(body.error.currentBalanceCents).toBe(100);
    expect(body.error.requiredCents).toBe(500);
  });

  it("allows sub-cent operations for zero-balance tenants", async () => {
    const ledger = new StubCreditLedger(0); // Zero balance
    const app = makeTestApp(ledger);

    const deps: CreditGateDeps = {
      creditLedger: ledger,
      topUpUrl: "/credits",
    };

    app.get("/check-subcent", async (c) => {
      const err = await creditBalanceCheck(c, deps, 0); // Sub-cent operation (0 cents estimated)
      if (err) {
        return c.json({ error: err }, 402);
      }
      return c.json({ ok: true });
    });

    const res = await app.request("/check-subcent", { method: "GET" });
    expect(res.status).toBe(200); // Should pass
  });
});

describe("debitCredits", () => {
  let ledger: StubCreditLedger;
  let deps: CreditGateDeps;

  beforeEach(() => {
    ledger = new StubCreditLedger(10000); // Start with 100 USD
    deps = {
      creditLedger: ledger,
      topUpUrl: "/credits",
    };
  });

  it("debits credits successfully", () => {
    const costUsd = 0.05; // 5 cents
    const margin = 1.3;

    debitCredits(deps, TENANT.id, costUsd, margin, "test-capability", "test-provider");

    // Expected: ceil(0.05 * 1.3 * 100) = ceil(6.5) = 7 cents
    const expectedBalance = 10000 - 7;
    expect(ledger.balance(TENANT.id)).toBe(expectedBalance);
  });

  it("does nothing when credit ledger is not configured", () => {
    const noDeps: CreditGateDeps = { topUpUrl: "/credits" };
    debitCredits(noDeps, TENANT.id, 1.0, 1.3, "test", "test");
    // Should not throw
  });

  it("does nothing when charge is zero or negative", () => {
    const initialBalance = ledger.balance(TENANT.id);
    debitCredits(deps, TENANT.id, 0, 1.3, "test", "test");
    expect(ledger.balance(TENANT.id)).toBe(initialBalance);
  });

  it("handles insufficient balance gracefully (fire-and-forget)", () => {
    ledger = new StubCreditLedger(5); // Only 5 cents
    deps.creditLedger = ledger;

    // Try to debit 10 cents
    debitCredits(deps, TENANT.id, 0.1, 1.0, "test", "test");

    // Balance goes negative (fire-and-forget pattern)
    expect(ledger.balance(TENANT.id)).toBeLessThan(0);
  });
});

describe("credit gate integration with streaming", () => {
  it("streaming path debits credits after proxy", async () => {
    const ledger = new StubCreditLedger(10000);
    const app = makeTestApp(ledger);

    const deps: CreditGateDeps = {
      creditLedger: ledger,
      topUpUrl: "/credits",
    };

    // Simulate streaming path
    app.post("/stream", async (c) => {
      const creditErr = await creditBalanceCheck(c, deps, 0);
      if (creditErr) {
        return c.json({ error: creditErr }, 402);
      }

      // Simulate streaming response with cost header
      const cost = 0.05; // 5 cents

      // Debit credits after streaming
      debitCredits(deps, TENANT.id, cost, 1.3, "chat-completions", "openrouter");

      return c.json({ streamed: true });
    });

    const initialBalance = ledger.balance(TENANT.id);
    const res = await app.request("/stream", { method: "POST" });
    expect(res.status).toBe(200);

    const finalBalance = ledger.balance(TENANT.id);
    expect(finalBalance).toBeLessThan(initialBalance);
    expect(initialBalance - finalBalance).toBeGreaterThan(0);
  });
});
