import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ArbitrageRouter } from "../monetization/arbitrage/router.js";
import type { ProxyDeps } from "./proxy.js";
import { chatCompletions } from "./proxy.js";
import type { GatewayAuthEnv } from "./service-key-auth.js";

function makeDeps(overrides: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    budgetChecker: { check: () => ({ allowed: true }) } as never,
    meter: { emit: vi.fn() } as never,
    creditLedger: { balance: () => 1000, debit: vi.fn() } as never,
    providers: { openrouter: { apiKey: "test-key", baseUrl: "https://mock.test" } },
    fetchFn: vi.fn() as ProxyDeps["fetchFn"],
    defaultMargin: 1.3,
    topUpUrl: "https://example.com/topup",
    metrics: { recordGatewayRequest: vi.fn(), recordGatewayError: vi.fn() } as never,
    ...overrides,
  };
}

function makeApp(deps: ProxyDeps) {
  const app = new Hono<GatewayAuthEnv>();
  app.use("*", async (c, next) => {
    c.set("gatewayTenant", {
      id: "tenant-1",
      spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
    } as never);
    await next();
  });
  app.post("/chat/completions", chatCompletions(deps));
  return app;
}

describe("chatCompletions arbitrage", () => {
  it("routes non-streaming request through arbitrage router when available", async () => {
    const mockRouter = {
      route: vi.fn().mockResolvedValue({
        result: {
          text: "Hello world",
          model: "openai/gpt-4o-mini",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        cost: 0.0001,
        provider: "openrouter",
      }),
    } as unknown as ArbitrageRouter;

    const deps = makeDeps({ arbitrageRouter: mockRouter });
    const app = makeApp(deps);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Hello world");
    expect(body.model).toBe("openai/gpt-4o-mini");
    expect(body.usage.prompt_tokens).toBe(10);
    expect(body.usage.completion_tokens).toBe(5);
    expect(mockRouter.route).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "text-generation", tenantId: "tenant-1" }),
    );
  });

  it("skips arbitrage for streaming requests", async () => {
    const mockRouter = { route: vi.fn() } as unknown as ArbitrageRouter;
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const deps = makeDeps({ arbitrageRouter: mockRouter, fetchFn: mockFetch });
    const app = makeApp(deps);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello" }],
        stream: true,
      }),
    });

    // Arbitrage router should NOT be called for streaming
    expect(mockRouter.route).not.toHaveBeenCalled();
    // Should fall through to direct OpenRouter proxy
    expect(mockFetch).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("falls back to direct proxy on NoProviderAvailableError", async () => {
    const { NoProviderAvailableError } = await import("../monetization/arbitrage/types.js");
    const mockRouter = {
      route: vi.fn().mockRejectedValue(new NoProviderAvailableError("text-generation")),
    } as unknown as ArbitrageRouter;
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "fallback" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const deps = makeDeps({ arbitrageRouter: mockRouter, fetchFn: mockFetch });
    const app = makeApp(deps);

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello" }],
      }),
    });

    expect(res.status).toBe(200);
    // Should have fallen through to direct OpenRouter
    expect(mockFetch).toHaveBeenCalled();
  });

  it("logs provider selection for billing accuracy", async () => {
    const mockRouter = {
      route: vi.fn().mockResolvedValue({
        result: {
          text: "response",
          model: "anthropic/claude-3.5-sonnet",
          usage: { inputTokens: 50, outputTokens: 25 },
        },
        cost: 0.002,
        provider: "self-hosted-llm",
      }),
    } as unknown as ArbitrageRouter;
    const deps = makeDeps({ arbitrageRouter: mockRouter });
    const app = makeApp(deps);

    await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    // Meter event should include the arbitrage-selected provider
    expect(deps.meter.emit).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "self-hosted-llm", capability: "chat-completions" }),
    );
  });
});
