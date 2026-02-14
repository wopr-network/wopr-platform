import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CreditLedger } from "./credits/credit-ledger.js";
import { createCreditGate, createFeatureGate, type GetUserBalance } from "./feature-gate.js";

// biome-ignore lint/suspicious/noExplicitAny: test helper type for flexible Hono vars
type AnyEnv = { Variables: Record<string, any> };

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createApp(getUserBalance: GetUserBalance, minBalance?: number) {
  const { requireBalance } = createFeatureGate({ getUserBalance });
  const app = new Hono<AnyEnv>();

  // Simulate auth middleware that sets user context
  app.use("/*", async (c, next) => {
    const userId = c.req.header("x-user-id");
    if (userId) {
      c.set("user", { id: userId });
    }
    return next();
  });

  app.get("/protected", requireBalance(minBalance), (c) => {
    const balance = c.get("balance");
    return c.json({ ok: true, balance });
  });

  return app;
}

// ---------------------------------------------------------------------------
// requireBalance middleware
// ---------------------------------------------------------------------------

describe("requireBalance middleware", () => {
  it("allows request when balance is positive", async () => {
    const app = createApp(() => 1000);
    const res = await app.request("/protected", {
      headers: { "x-user-id": "tenant-1" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.balance).toBe(1000);
  });

  it("rejects request when balance is zero", async () => {
    const app = createApp(() => 0);
    const res = await app.request("/protected", {
      headers: { "x-user-id": "tenant-1" },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("Insufficient credit balance");
    expect(body.purchaseUrl).toBe("/settings/billing");
  });

  it("rejects request when balance is negative", async () => {
    const app = createApp(() => -100);
    const res = await app.request("/protected", {
      headers: { "x-user-id": "tenant-1" },
    });

    expect(res.status).toBe(402);
  });

  it("enforces minimum balance when specified", async () => {
    const app = createApp(() => 50, 100);
    const res = await app.request("/protected", {
      headers: { "x-user-id": "tenant-1" },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.currentBalanceCents).toBe(50);
    expect(body.requiredBalanceCents).toBe(100);
  });

  it("allows request when balance exceeds minimum", async () => {
    const app = createApp(() => 200, 100);
    const res = await app.request("/protected", {
      headers: { "x-user-id": "tenant-1" },
    });

    expect(res.status).toBe(200);
  });

  it("returns 401 when no user is set", async () => {
    const app = createApp(() => 1000);
    const res = await app.request("/protected");

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("works with async balance resolver", async () => {
    const app = createApp(async () => 500);
    const res = await app.request("/protected", {
      headers: { "x-user-id": "tenant-1" },
    });

    expect(res.status).toBe(200);
  });

  it("uses custom userKey and userIdField", async () => {
    const { requireBalance } = createFeatureGate({
      getUserBalance: () => 1000,
      userKey: "account",
      userIdField: "tenantId",
    });

    const app = new Hono<AnyEnv>();
    app.use("/*", async (c, next) => {
      c.set("account", { tenantId: "t-1" });
      return next();
    });
    app.get("/check", requireBalance(), (c) => c.json({ ok: true }));

    const res = await app.request("/check");
    expect(res.status).toBe(200);
  });

  it("sets balance on context for downstream handlers", async () => {
    const app = createApp(() => 4200);
    const res = await app.request("/protected", {
      headers: { "x-user-id": "tenant-1" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balance).toBe(4200);
  });

  it("default minBalance of 0 allows any positive balance", async () => {
    const app = createApp(() => 1);
    const res = await app.request("/protected", {
      headers: { "x-user-id": "tenant-1" },
    });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// requireCredits middleware (WOP-380)
// ---------------------------------------------------------------------------

function createCreditApp(balanceCents: number, minCents?: number) {
  const mockLedger = { balance: vi.fn().mockReturnValue(balanceCents) } as unknown as CreditLedger;
  const { requireCredits } = createCreditGate({
    ledger: mockLedger,
    resolveTenantId: (c) => c.req.header("x-tenant-id"),
  });

  const app = new Hono<AnyEnv>();
  app.post("/action", requireCredits(minCents), (c) => {
    const creditBalance = c.get("creditBalance");
    return c.json({ ok: true, creditBalance });
  });

  return app;
}

describe("requireCredits middleware (WOP-380)", () => {
  it("allows request when balance meets default minimum (17 cents)", async () => {
    const app = createCreditApp(17);
    const res = await app.request("/action", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-1" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.creditBalance).toBe(17);
  });

  it("rejects when balance is below default minimum (17 cents)", async () => {
    const app = createCreditApp(16);
    const res = await app.request("/action", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-1" },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("insufficient_credits");
    expect(body.balance).toBe(16);
    expect(body.required).toBe(17);
    expect(body.buyUrl).toBe("/dashboard/credits");
  });

  it("rejects when balance is zero", async () => {
    const app = createCreditApp(0);
    const res = await app.request("/action", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-1" },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("insufficient_credits");
    expect(body.balance).toBe(0);
  });

  it("respects custom minCents parameter", async () => {
    const app = createCreditApp(50, 100);
    const res = await app.request("/action", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-1" },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.required).toBe(100);
  });

  it("allows request when balance exceeds custom minCents", async () => {
    const app = createCreditApp(200, 100);
    const res = await app.request("/action", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-1" },
    });

    expect(res.status).toBe(200);
  });

  it("returns 401 when tenant cannot be resolved", async () => {
    const app = createCreditApp(1000);
    const res = await app.request("/action", { method: "POST" });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("sets creditBalance on context for downstream handlers", async () => {
    const app = createCreditApp(4200);
    const res = await app.request("/action", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-1" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creditBalance).toBe(4200);
  });
});
