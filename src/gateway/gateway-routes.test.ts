/**
 * Integration tests for the gateway proxy routes (WOP-1222).
 *
 * Covers: auth rejection, credit checks, proxy forwarding,
 * credit deduction, upstream error handling, and body size limits.
 *
 * Uses mocked deps — no PGlite required.
 */

import type { ICreditLedger } from "@wopr-network/platform-core/credits";
import { Credit } from "@wopr-network/platform-core/credits";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetCheckResult, IBudgetChecker } from "../monetization/budget/budget-checker.js";
import { createGatewayRoutes } from "./routes.js";
import type { GatewayConfig, GatewayTenant } from "./types.js";

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const VALID_KEY = "sk-test-valid-key";
const INVALID_KEY = "sk-test-invalid-key";

const TEST_TENANT: GatewayTenant = {
  id: "tenant-1",
  spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
};

function buildTestConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const meter = {
    emit: vi.fn(),
    flush: vi.fn(),
    pending: 0,
    close: vi.fn(),
    queryEvents: vi.fn(),
  };
  const budgetChecker = {
    check: vi.fn().mockResolvedValue({
      allowed: true,
      currentHourlySpend: 0,
      currentMonthlySpend: 0,
      maxSpendPerHour: null,
      maxSpendPerMonth: null,
    } satisfies BudgetCheckResult),
    invalidate: vi.fn(),
    clearCache: vi.fn(),
  } satisfies IBudgetChecker;
  const creditLedger = {
    balance: vi.fn().mockResolvedValue(Credit.fromCents(10000)),
    debit: vi.fn().mockResolvedValue(undefined),
    credit: vi.fn(),
    history: vi.fn(),
  } as unknown as ICreditLedger;
  const fetchFn = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "x-openrouter-cost": "0.001" },
      },
    ),
  );

  return {
    meter: meter as unknown as import("@wopr-network/platform-core/metering").MeterEmitter,
    budgetChecker: budgetChecker as unknown as import("../monetization/budget/budget-checker.js").BudgetChecker,
    creditLedger,
    providers: { openrouter: { apiKey: "or-test-key" } },
    fetchFn,
    resolveServiceKey: (key: string) => (key === VALID_KEY ? TEST_TENANT : null),
    ...overrides,
  };
}

function buildApp(config: GatewayConfig) {
  const app = new Hono();
  app.route("/v1", createGatewayRoutes(config));
  return app;
}

function chatRequest(app: ReturnType<typeof buildApp>, token: string, body?: object) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? { model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("gateway routes — auth", () => {
  let config: GatewayConfig;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    config = buildTestConfig();
    app = buildApp(config);
  });

  it("rejects requests with no Authorization header (401)", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4", messages: [] }),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("missing_api_key");
  });

  it("rejects requests with invalid Bearer token (401)", async () => {
    const res = await chatRequest(app, INVALID_KEY);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("invalid_api_key");
  });

  it("rejects requests with malformed Authorization header (401)", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Basic dXNlcjpwYXNz",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4", messages: [] }),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("invalid_auth_format");
  });

  it("rejects requests with empty Bearer token (401)", async () => {
    const res = await chatRequest(app, "");
    expect(res.status).toBe(401);
  });

  it("allows requests with valid service key (200)", async () => {
    const res = await chatRequest(app, VALID_KEY);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Credit check
// ---------------------------------------------------------------------------

describe("gateway routes — credit check", () => {
  it("returns 402 when credits exhausted (balance at grace buffer limit)", async () => {
    const config = buildTestConfig({
      creditLedger: {
        balance: vi.fn().mockResolvedValue(Credit.fromCents(-50)),
        debit: vi.fn(),
        credit: vi.fn(),
        history: vi.fn(),
      } as unknown as ICreditLedger,
    });
    const app = buildApp(config);
    const res = await chatRequest(app, VALID_KEY);
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error.code).toBe("credits_exhausted");
    expect(json.error.needsCredits).toBe(true);
  });

  it("returns 402 (insufficient_credits) when balance is zero and below estimated cost", async () => {
    // estimatedCostCents=1 for chat completions
    // creditBalanceCheck: !balance.isNegative() && balance < required(1) → insufficient_credits
    // Credit.fromCents(0).isNegative() = false, and 0 < 1 → triggers insufficient_credits
    const config = buildTestConfig({
      creditLedger: {
        balance: vi.fn().mockResolvedValue(Credit.fromCents(0)),
        debit: vi.fn(),
        credit: vi.fn(),
        history: vi.fn(),
      } as unknown as ICreditLedger,
    });
    const app = buildApp(config);
    const res = await chatRequest(app, VALID_KEY);
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error.code).toBe("insufficient_credits");
  });

  it("does NOT forward request to provider when credits exhausted", async () => {
    const fetchFn = vi.fn();
    const config = buildTestConfig({
      creditLedger: {
        balance: vi.fn().mockResolvedValue(Credit.fromCents(-50)),
        debit: vi.fn(),
        credit: vi.fn(),
        history: vi.fn(),
      } as unknown as ICreditLedger,
      fetchFn,
    });
    const app = buildApp(config);
    await chatRequest(app, VALID_KEY);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns 402 when budget checker rejects", async () => {
    const config = buildTestConfig();
    (config.budgetChecker.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      reason: "Budget exceeded",
      currentHourlySpend: 100,
      currentMonthlySpend: 1000,
      maxSpendPerHour: 50,
      maxSpendPerMonth: 500,
    });
    const app = buildApp(config);
    const res = await chatRequest(app, VALID_KEY);
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error.code).toBe("insufficient_credits");
  });
});

// ---------------------------------------------------------------------------
// Proxy forwarding
// ---------------------------------------------------------------------------

describe("gateway routes — proxy forwarding", () => {
  it("forwards request to upstream OpenRouter with Authorization header", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", "x-openrouter-cost": "0.0005" },
        },
      ),
    );
    const config = buildTestConfig({ fetchFn });
    const app = buildApp(config);

    await chatRequest(app, VALID_KEY, { model: "gpt-4", messages: [{ role: "user", content: "test" }] });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer or-test-key");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.method).toBe("POST");
  });

  it("returns upstream response body and status to caller", async () => {
    const config = buildTestConfig();
    const app = buildApp(config);
    const res = await chatRequest(app, VALID_KEY);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("hello");
  });

  it("emits meter event on successful proxy", async () => {
    const config = buildTestConfig();
    const app = buildApp(config);
    await chatRequest(app, VALID_KEY);
    expect(config.meter.emit as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    const event = (config.meter.emit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.tenant).toBe("tenant-1");
    expect(event.capability).toBe("chat-completions");
    expect(event.provider).toBe("openrouter");
  });
});

// ---------------------------------------------------------------------------
// Credit deduction
// ---------------------------------------------------------------------------

describe("gateway routes — credit deduction", () => {
  it("calls creditLedger.debit after successful proxy response", async () => {
    const config = buildTestConfig();
    const app = buildApp(config);
    await chatRequest(app, VALID_KEY);

    // debitCredits is fire-and-forget — give it a tick to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(config.creditLedger?.debit).toHaveBeenCalled();
    const [tenantId] = (config.creditLedger?.debit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tenantId).toBe("tenant-1");
  });

  it("does NOT debit credits when no creditLedger is configured", async () => {
    const config = buildTestConfig({ creditLedger: undefined });
    const app = buildApp(config);
    const res = await chatRequest(app, VALID_KEY);
    // No creditLedger — verify no crash and request succeeds
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Error handling — upstream failure
// ---------------------------------------------------------------------------

describe("gateway routes — error handling", () => {
  it("returns 502 when upstream fetch throws", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("connection refused"));
    const config = buildTestConfig({ fetchFn });
    const app = buildApp(config);
    const res = await chatRequest(app, VALID_KEY);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe("upstream_error");
  });

  it("does NOT debit credits when upstream fetch throws", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("connection refused"));
    const config = buildTestConfig({ fetchFn });
    const app = buildApp(config);
    await chatRequest(app, VALID_KEY);
    await new Promise((r) => setTimeout(r, 10));
    expect(config.creditLedger?.debit).not.toHaveBeenCalled();
  });

  it("does NOT debit credits when upstream returns non-200 status", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "model not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const config = buildTestConfig({ fetchFn });
    const app = buildApp(config);
    const res = await chatRequest(app, VALID_KEY);
    // 404 is passed through as-is (non-ok response is proxied directly)
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 10));
    expect(config.creditLedger?.debit).not.toHaveBeenCalled();
  });

  it("returns 503 when openrouter provider not configured", async () => {
    const config = buildTestConfig({ providers: {} });
    const app = buildApp(config);
    const res = await chatRequest(app, VALID_KEY);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.code).toBe("service_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Body size limit (WOP-655 regression)
// ---------------------------------------------------------------------------

describe("gateway routes — body size limit (WOP-655)", () => {
  it("rejects oversized LLM request body with 413 (valid auth required)", async () => {
    // Body limit runs AFTER auth in Hono middleware stack
    // so we need a valid Bearer token for the 413 to be returned
    const config = buildTestConfig();
    const app = buildApp(config);
    const oversizedBody = "x".repeat(10 * 1024 * 1024 + 1); // > 10MB
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_KEY}`,
        "Content-Type": "application/json",
      },
      body: oversizedBody,
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error.code).toBe("request_too_large");
  });

  it("does NOT forward oversized body to provider", async () => {
    const fetchFn = vi.fn();
    const config = buildTestConfig({ fetchFn });
    const app = buildApp(config);
    const oversizedBody = "x".repeat(10 * 1024 * 1024 + 1);
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_KEY}`,
        "Content-Type": "application/json",
      },
      body: oversizedBody,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
