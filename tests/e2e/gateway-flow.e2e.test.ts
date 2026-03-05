import { unlink } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleRateLimitRepository } from "../../src/api/drizzle-rate-limit-repository.js";
import type { DrizzleDb } from "../../src/db/index.js";
import { DrizzleCircuitBreakerRepository } from "../../src/gateway/drizzle-circuit-breaker-repository.js";
import type {
  AdapterResult,
  ImageGenerationInput,
  ImageGenerationOutput,
  ProviderAdapter,
  TextGenerationOutput,
} from "../../src/monetization/adapters/types.js";
import { withMargin } from "../../src/monetization/adapters/types.js";
import { BudgetChecker } from "../../src/monetization/budget/budget-checker.js";
import { Credit } from "../../src/monetization/credit.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { grantSignupCredits, SIGNUP_GRANT } from "../../src/monetization/credits/signup-grant.js";
import { DrizzleMeterEmitter as MeterEmitter } from "../../src/monetization/metering/emitter.js";
import { DrizzleMeterEventRepository } from "../../src/monetization/metering/meter-event-repository.js";
import { AdapterSocket } from "../../src/monetization/socket/socket.js";
import { createTestDb } from "../../src/test/db.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Fake adapters — instant, no network
// ---------------------------------------------------------------------------

function createFakeTextGenAdapter(): ProviderAdapter {
  return {
    name: "fake-openai",
    capabilities: ["text-generation"],
    selfHosted: false,
    async generateText(_input: unknown) {
      return {
        result: {
          text: "Hello! I am a fake AI response.",
          model: "gpt-4o",
          usage: {
            inputTokens: 10,
            outputTokens: 20,
          },
        },
        cost: Credit.fromDollars(0.001),
      } satisfies AdapterResult<TextGenerationOutput>;
    },
  };
}

function createFakeImageGenAdapter(): ProviderAdapter {
  return {
    name: "fake-replicate-sdxl",
    capabilities: ["image-generation"],
    selfHosted: false,
    async generateImage(_input: ImageGenerationInput) {
      return {
        result: {
          images: ["https://fake-cdn.example.com/generated-image.png"],
          model: "sdxl-1.0",
        },
        cost: Credit.fromDollars(0.02),
      } satisfies AdapterResult<ImageGenerationOutput>;
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E: gateway flow — plugin request → provider proxy → metered response", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: CreditLedger;
  let meter: MeterEmitter;
  let socket: AdapterSocket;
  let walPath: string;
  let dlqPath: string;

  const TENANT_ID = `e2e-gateway-${Date.now()}`;

  beforeEach(async () => {
    const ts = Date.now();
    walPath = `/tmp/wopr-e2e-gw-wal-${ts}.jsonl`;
    dlqPath = `/tmp/wopr-e2e-gw-dlq-${ts}.jsonl`;

    ({ db, pool } = await createTestDb());

    ledger = new CreditLedger(db);

    meter = new MeterEmitter(new DrizzleMeterEventRepository(db), {
      flushIntervalMs: 100,
      batchSize: 1,
      walPath,
      dlqPath,
    });

    socket = new AdapterSocket({
      meter,
      defaultMargin: 1.3,
    });
  });

  afterEach(async () => {
    meter.close();
    await pool.close();
    await unlink(walPath).catch(() => {});
    await unlink(dlqPath).catch(() => {});
  });

  // =========================================================================
  // TEST 1: Complete gateway flow — credit check → adapter call → meter → debit
  // =========================================================================

  it("complete gateway flow: credits seeded → socket.execute → meter event → credit debit", async () => {
    await grantSignupCredits(ledger, TENANT_ID);
    expect((await ledger.balance(TENANT_ID)).equals(SIGNUP_GRANT)).toBe(true);

    socket.register(createFakeImageGenAdapter());

    const result = await socket.execute<ImageGenerationOutput>({
      tenantId: TENANT_ID,
      capability: "image-generation",
      input: { prompt: "A robot painting", width: 1024, height: 1024 },
    });

    expect(result.images).toHaveLength(1);
    expect(result.model).toBe("sdxl-1.0");

    await meter.flush();

    const events = await meter.queryEvents(TENANT_ID);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const event = events[0];
    expect(event.tenant).toBe(TENANT_ID);
    expect(event.capability).toBe("image-generation");
    expect(event.provider).toBe("fake-replicate-sdxl");

    const costDollars = Credit.fromRaw(event.cost).toDollars();
    const chargeDollars = Credit.fromRaw(event.charge).toDollars();
    expect(costDollars).toBeCloseTo(0.02, 5);
    expect(chargeDollars).toBeCloseTo(0.026, 5); // 0.02 * 1.3

    const chargeCredit = Credit.fromRaw(event.charge);
    await ledger.debit(TENANT_ID, chargeCredit, "adapter_usage", "image-generation via fake-replicate-sdxl", event.id);

    const balanceAfter = await ledger.balance(TENANT_ID);
    expect(balanceAfter.lessThan(SIGNUP_GRANT)).toBe(true);
    expect(balanceAfter.isNegative()).toBe(false);

    const history = await ledger.history(TENANT_ID);
    expect(history.length).toBe(2); // signup_grant + adapter_usage
    const debitTx = history.find((tx) => tx.type === "adapter_usage");
    expect(debitTx).toBeDefined();
    expect(debitTx!.amount.isNegative()).toBe(true);
  });

  // =========================================================================
  // TEST 2: Credits exhausted → debit pushes balance negative
  // =========================================================================

  it("credits exhausted: socket.execute succeeds but debit pushes balance negative", async () => {
    await ledger.credit(TENANT_ID, Credit.fromCents(1), "promo", "tiny grant");

    socket.register(createFakeImageGenAdapter());

    const result = await socket.execute<ImageGenerationOutput>({
      tenantId: TENANT_ID,
      capability: "image-generation",
      input: { prompt: "test", width: 512, height: 512 },
    });
    expect(result.images).toHaveLength(1);

    await meter.flush();
    const events = await meter.queryEvents(TENANT_ID);
    const chargeCredit = Credit.fromRaw(events[0].charge);

    // Debit with allowNegative=true (how the real gateway works)
    await ledger.debit(TENANT_ID, chargeCredit, "adapter_usage", "image-gen", undefined, true);

    const balance = await ledger.balance(TENANT_ID);
    expect(balance.isNegative()).toBe(true);
  });

  // =========================================================================
  // TEST 3: Budget checker blocks when hourly spend exceeded
  // =========================================================================

  it("budget checker blocks request when hourly spend limit exceeded", async () => {
    await grantSignupCredits(ledger, TENANT_ID);

    const budgetChecker = new BudgetChecker(db, { cacheTtlMs: 0 });

    // Insert a meter event worth $0.60 to exceed $0.50 hourly limit
    const { meterEvents } = await import("../../src/db/schema/meter-events.js");
    await db.insert(meterEvents).values({
      id: `budget-test-${Date.now()}`,
      tenant: TENANT_ID,
      cost: Credit.fromDollars(0.3).toRaw(),
      charge: Credit.fromDollars(0.6).toRaw(),
      capability: "chat",
      provider: "openrouter",
      timestamp: Date.now(),
    });

    const result = await budgetChecker.check(TENANT_ID, {
      maxSpendPerHour: 0.5,
      maxSpendPerMonth: 5,
      label: "free",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Hourly");
  });

  // =========================================================================
  // TEST 4: Circuit breaker trips after too many requests
  // =========================================================================

  it("circuit breaker trips after exceeding maxRequestsPerWindow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-21T12:00:00Z"));

    const cbRepo = new DrizzleCircuitBreakerRepository(db);
    const instanceId = `inst-${Date.now()}`;

    const maxReqs = 3;

    for (let i = 0; i < maxReqs; i++) {
      await cbRepo.incrementOrReset(instanceId, 10_000);
    }

    const state = await cbRepo.incrementOrReset(instanceId, 10_000);
    expect(state.count).toBe(maxReqs + 1);
    expect(state.count).toBeGreaterThan(maxReqs);

    await cbRepo.trip(instanceId);

    const tripped = await cbRepo.get(instanceId);
    expect(tripped).not.toBeNull();
    expect(tripped!.trippedAt).not.toBeNull();

    vi.advanceTimersByTime(300_001);

    await cbRepo.reset(instanceId);
    const reset = await cbRepo.get(instanceId);
    expect(reset!.trippedAt).toBeNull();
    expect(reset!.count).toBe(0);

    vi.useRealTimers();
  });

  // =========================================================================
  // TEST 5: Rate limiter tracks per-tenant per-capability request counts
  // =========================================================================

  it("rate limiter tracks per-tenant per-capability request counts", async () => {
    const rlRepo = new DrizzleRateLimitRepository(db);
    const tenantId = `rl-tenant-${Date.now()}`;

    for (let i = 0; i < 5; i++) {
      await rlRepo.increment(tenantId, "cap:llm", 60_000);
    }

    const entry = await rlRepo.get(tenantId, "cap:llm");
    expect(entry).not.toBeNull();
    expect(entry!.count).toBe(5);

    await rlRepo.increment(tenantId, "cap:imageGen", 60_000);
    const imgEntry = await rlRepo.get(tenantId, "cap:imageGen");
    expect(imgEntry!.count).toBe(1);
  });

  // =========================================================================
  // TEST 6: OpenAI protocol path — full Hono app test
  // =========================================================================

  it("OpenAI protocol: auth → budget → proxy → meter → response", async () => {
    await grantSignupCredits(ledger, TENANT_ID);

    const budgetChecker = new BudgetChecker(db, { cacheTtlMs: 0 });

    const fakeFetch: (url: string, init?: RequestInit) => Promise<Response> = async (_url, _init) => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-openrouter-cost": "0.001",
          },
        },
      );
    };

    const { createOpenAIRoutes } = await import("../../src/gateway/protocol/openai.js");

    const app = createOpenAIRoutes({
      meter,
      budgetChecker,
      creditLedger: ledger,
      topUpUrl: "/billing",
      providers: { openrouter: { apiKey: "fake-key" } },
      defaultMargin: 1.3,
      fetchFn: fakeFetch,
      resolveServiceKey: (key) =>
        key === "test-key"
          ? { id: TENANT_ID, spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null } }
          : null,
      withMarginFn: withMargin,
    });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe("Hello!");

    await meter.flush();
    const events = await meter.queryEvents(TENANT_ID);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].capability).toBe("chat-completions");
    expect(events[0].provider).toBe("openrouter");
  });

  // =========================================================================
  // TEST 7: Anthropic protocol path — full Hono app test
  // =========================================================================

  it("Anthropic protocol: x-api-key auth → budget → proxy → translate → meter → response", async () => {
    await grantSignupCredits(ledger, TENANT_ID);

    const budgetChecker = new BudgetChecker(db, { cacheTtlMs: 0 });

    const fakeFetch: (url: string, init?: RequestInit) => Promise<Response> = async (_url, _init) => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Bonjour!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-openrouter-cost": "0.002",
          },
        },
      );
    };

    const { createAnthropicRoutes } = await import("../../src/gateway/protocol/anthropic.js");

    const app = createAnthropicRoutes({
      meter,
      budgetChecker,
      creditLedger: ledger,
      topUpUrl: "/billing",
      providers: { openrouter: { apiKey: "fake-key" } },
      defaultMargin: 1.3,
      fetchFn: fakeFetch,
      resolveServiceKey: (key) =>
        key === "anthropic-test-key"
          ? { id: TENANT_ID, spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null } }
          : null,
      withMarginFn: withMargin,
    });

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "anthropic-test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe("Bonjour!");

    await meter.flush();
    const events = await meter.queryEvents(TENANT_ID);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].capability).toBe("chat-completions");
  });

  // =========================================================================
  // TEST 8: Provider failure — no meter event emitted
  // =========================================================================

  it("provider failure: socket.execute throws, no meter event emitted", async () => {
    await grantSignupCredits(ledger, TENANT_ID);

    socket.register({
      name: "failing-provider",
      capabilities: ["text-generation"],
      selfHosted: false,
      async generateText() {
        throw new Error("Provider unavailable");
      },
    });

    await expect(
      socket.execute({
        tenantId: TENANT_ID,
        capability: "text-generation",
        input: { prompt: "test" },
      }),
    ).rejects.toThrow("Provider unavailable");

    await meter.flush();
    const events = await meter.queryEvents(TENANT_ID);
    expect(events.length).toBe(0);
  });

  // =========================================================================
  // TEST 9: Performance — socket.execute < 5 seconds
  // =========================================================================

  it("socket.execute completes in under 5 seconds with fake provider", async () => {
    await grantSignupCredits(ledger, TENANT_ID);
    socket.register(createFakeImageGenAdapter());

    const start = performance.now();
    await socket.execute<ImageGenerationOutput>({
      tenantId: TENANT_ID,
      capability: "image-generation",
      input: { prompt: "perf test", width: 512, height: 512 },
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(5000);
  });
});
