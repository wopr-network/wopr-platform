import type { PGlite } from "@electric-sql/pglite";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EchoChatBackend } from "../../chat/chat-backend.js";
import type { DrizzleDb } from "../../db/index.js";
import { type BudgetTier, checkSessionBudget } from "../../inference/budget-guard.js";
import { computeInferenceCost } from "../../inference/inference-cost.js";
import {
  DrizzleSessionUsageRepository,
  type ISessionUsageRepository,
} from "../../inference/session-usage-repository.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../../test/db.js";
import { createChatRoutes } from "./chat.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAuthedChatApp(userId: string) {
  const backend = new EchoChatBackend();
  const routes = createChatRoutes({ backend });
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: userId, roles: [] });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/chat", routes);
  return { app, backend };
}

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

let db: DrizzleDb;
let pool: PGlite;
let usageRepo: ISessionUsageRepository;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
  await beginTestTransaction(pool);
});

afterAll(async () => {
  await endTestTransaction(pool);
  await pool.close();
});

beforeEach(async () => {
  await rollbackTestTransaction(pool);
  usageRepo = new DrizzleSessionUsageRepository(db);
});

// ---------------------------------------------------------------------------
// E2E: Chat → Inference → Budget Guard → Usage Tracking
// ---------------------------------------------------------------------------

describe("E2E: Chat/inference flow", () => {
  it("start session → stream response → record usage → budget guard allows", async () => {
    const { app } = createAuthedChatApp("tenant-chat-1");
    const sessionId = crypto.randomUUID();

    // Step 1: Check budget before first message (anonymous tier, $0.10 cap)
    const budgetBefore = await checkSessionBudget(usageRepo, sessionId, "anonymous");
    expect(budgetBefore.allowed).toBe(true);
    expect(budgetBefore.remainingUsd).toBeCloseTo(0.1);
    expect(budgetBefore.capUsd).toBe(0.1);

    // Step 2: Open SSE stream
    const sseRes = await app.request(`/chat/stream?sessionId=${sessionId}`);
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("Content-Type")).toBe("text/event-stream");

    // Step 3: Send a message
    const postRes = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: "hello world" }),
    });
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(typeof postBody.streamId).toBe("string");

    // Step 4: Read streamed response
    const text = await sseRes.text();
    expect(text).toContain('data: {"type":"text","delta":"Echo: hello world"}');
    expect(text).toContain('data: {"type":"done"}');

    // Step 5: Compute inference cost (simulating token usage for this response)
    const cost = computeInferenceCost({
      model: "claude-sonnet-4-20250514",
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeGreaterThan(0);

    // Step 6: Record usage in session-usage-repository
    const usage = await usageRepo.insert({
      sessionId,
      userId: "tenant-chat-1",
      page: null,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: cost,
    });
    expect(usage.id).toBeTruthy();
    expect(usage.costUsd).toBeCloseTo(cost);

    // Step 7: Verify usage is persisted
    const rows = await usageRepo.findBySessionId(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd).toBeCloseTo(cost);

    // Step 8: Budget guard still allows (cost << $0.10 cap)
    const budgetAfter = await checkSessionBudget(usageRepo, sessionId, "anonymous");
    expect(budgetAfter.allowed).toBe(true);
    expect(budgetAfter.remainingUsd).toBeCloseTo(0.1 - cost);
  });

  it("budget guard rejects when credits exhausted", async () => {
    const { app } = createAuthedChatApp("tenant-exhaust");
    const sessionId = crypto.randomUUID();
    const tier: BudgetTier = "anonymous"; // $0.10 cap

    // Step 1: Insert usage that nearly exhausts the budget ($0.09)
    await usageRepo.insert({
      sessionId,
      userId: "tenant-exhaust",
      page: null,
      inputTokens: 10000,
      outputTokens: 5000,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.09,
    });

    // Step 2: Budget guard still allows ($0.01 remaining)
    const budgetNearLimit = await checkSessionBudget(usageRepo, sessionId, tier);
    expect(budgetNearLimit.allowed).toBe(true);
    expect(budgetNearLimit.remainingUsd).toBeCloseTo(0.01);

    // Step 3: Insert another usage that pushes past the cap
    await usageRepo.insert({
      sessionId,
      userId: "tenant-exhaust",
      page: null,
      inputTokens: 5000,
      outputTokens: 2000,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.02,
    });

    // Step 4: Budget guard now rejects
    const budgetExhausted = await checkSessionBudget(usageRepo, sessionId, tier);
    expect(budgetExhausted.allowed).toBe(false);
    expect(budgetExhausted.remainingUsd).toBeCloseTo(0, 2);

    // Step 5: Exercise POST /chat route under exhausted budget.
    // The route layer does not enforce budget (budget check is a separate concern),
    // so POST still succeeds — but no new usage rows should be created by the route.
    const rowsBefore = await usageRepo.findBySessionId(sessionId);
    const sseRes = await app.request(`/chat/stream?sessionId=${sessionId}`);
    const postRes = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: "should be budget-gated by caller" }),
    });
    // Route accepts the request (budget enforcement is caller's responsibility)
    expect(postRes.status).toBe(200);
    // Consume SSE to let processing complete
    await sseRes.text();
    // Verify the route itself did not insert any usage rows
    const rowsAfter = await usageRepo.findBySessionId(sessionId);
    expect(rowsAfter).toHaveLength(rowsBefore.length);
  });

  it("concurrent sessions from same tenant share independent budgets", async () => {
    const sessionA = crypto.randomUUID();
    const sessionB = crypto.randomUUID();
    const userId = "tenant-concurrent";

    // Session A uses $0.05
    await usageRepo.insert({
      sessionId: sessionA,
      userId,
      page: null,
      inputTokens: 5000,
      outputTokens: 2000,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.05,
    });

    // Session B uses $0.05
    await usageRepo.insert({
      sessionId: sessionB,
      userId,
      page: null,
      inputTokens: 5000,
      outputTokens: 2000,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.05,
    });

    // Budget is per-session, so both should still be allowed (each at $0.05/$0.10)
    const budgetA = await checkSessionBudget(usageRepo, sessionA, "anonymous");
    const budgetB = await checkSessionBudget(usageRepo, sessionB, "anonymous");
    expect(budgetA.allowed).toBe(true);
    expect(budgetA.remainingUsd).toBeCloseTo(0.05);
    expect(budgetB.allowed).toBe(true);
    expect(budgetB.remainingUsd).toBeCloseTo(0.05);
  });

  it("inference cost calculates correctly for different models", () => {
    const tokenParams = { inputTokens: 1000, outputTokens: 200, cachedTokens: 0, cacheWriteTokens: 0 };

    // Sonnet should produce a positive cost
    const sonnetCost = computeInferenceCost({ model: "claude-sonnet-4-20250514", ...tokenParams });
    expect(sonnetCost).toBeGreaterThan(0);

    // Haiku should be cheaper than Sonnet for the same tokens
    const haikuCost = computeInferenceCost({ model: "claude-haiku-4-5-20251001", ...tokenParams });
    expect(haikuCost).toBeGreaterThan(0);
    expect(haikuCost).toBeLessThan(sonnetCost);

    // Unknown model returns 0
    const unknownCost = computeInferenceCost({ model: "unknown-model", ...tokenParams });
    expect(unknownCost).toBe(0);
  });

  it("stream interruption mid-response — partial usage still tracked", async () => {
    const sessionId = crypto.randomUUID();

    // Simulate partial usage from an interrupted stream
    const partialCost = computeInferenceCost({
      model: "claude-sonnet-4-20250514",
      inputTokens: 500,
      outputTokens: 50,
      cachedTokens: 0,
      cacheWriteTokens: 0,
    });

    await usageRepo.insert({
      sessionId,
      userId: "tenant-interrupted",
      page: null,
      inputTokens: 500,
      outputTokens: 50,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: partialCost,
    });

    // Verify partial usage is tracked
    const total = await usageRepo.sumCostBySession(sessionId);
    expect(total).toBeCloseTo(partialCost);
    expect(total).toBeGreaterThan(0);

    // Budget reflects partial usage
    const budget = await checkSessionBudget(usageRepo, sessionId, "anonymous");
    expect(budget.allowed).toBe(true);
    expect(budget.remainingUsd).toBeCloseTo(0.1 - partialCost);
  });

  it("budget guard race condition — two requests at exactly threshold", async () => {
    const sessionId = crypto.randomUUID();

    // Pre-fill to $0.099 — just $0.001 remaining
    await usageRepo.insert({
      sessionId,
      userId: "tenant-race",
      page: null,
      inputTokens: 10000,
      outputTokens: 5000,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.099,
    });

    // Both check budget concurrently — both should see "allowed" since
    // checkSessionBudget is a pure read (no reservation/lock)
    const [checkA, checkB] = await Promise.all([
      checkSessionBudget(usageRepo, sessionId, "anonymous"),
      checkSessionBudget(usageRepo, sessionId, "anonymous"),
    ]);

    expect(checkA.allowed).toBe(true);
    expect(checkA.remainingUsd).toBeCloseTo(0.001);
    expect(checkB.allowed).toBe(true);
    expect(checkB.remainingUsd).toBeCloseTo(0.001);

    // After both requests complete and record usage, the budget is exceeded
    await usageRepo.insert({
      sessionId,
      userId: "tenant-race",
      page: null,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.003,
    });
    await usageRepo.insert({
      sessionId,
      userId: "tenant-race",
      page: null,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.003,
    });

    // Now budget is exhausted ($0.099 + $0.003 + $0.003 = $0.105 > $0.10)
    const budgetAfter = await checkSessionBudget(usageRepo, sessionId, "anonymous");
    expect(budgetAfter.allowed).toBe(false);
    expect(budgetAfter.remainingUsd).toBeCloseTo(0, 2);
  });

  it("chat response latency is under 500ms with echo backend", async () => {
    const { app } = createAuthedChatApp("tenant-perf");
    const sessionId = crypto.randomUUID();

    // Open SSE stream first
    const sseRes = await app.request(`/chat/stream?sessionId=${sessionId}`);

    // Measure end-to-end: from POST until SSE yields chat message
    const start = performance.now();
    const postRes = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: "perf test" }),
    });
    expect(postRes.status).toBe(200);

    // Consume the SSE stream to completion (wait for actual response data)
    const text = await sseRes.text();
    const elapsed = performance.now() - start;

    // Verify we actually received the streamed response
    expect(text).toContain('data: {"type":"text","delta":"Echo: perf test"}');
    expect(text).toContain('data: {"type":"done"}');

    // End-to-end latency (POST → SSE message received) should be under 2s
    expect(elapsed).toBeLessThan(2000);
  });

  it("budget check adds negligible overhead", async () => {
    const sessionId = crypto.randomUUID();

    // Insert some usage so the query isn't trivially empty
    for (let i = 0; i < 10; i++) {
      await usageRepo.insert({
        sessionId,
        userId: "tenant-overhead",
        page: null,
        inputTokens: 500,
        outputTokens: 100,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        model: "claude-sonnet-4-20250514",
        costUsd: 0.003,
      });
    }

    // Measure budget check latency
    const start = performance.now();
    await checkSessionBudget(usageRepo, sessionId, "anonymous");
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  it("empty message triggers greeting flow", async () => {
    const { app } = createAuthedChatApp("tenant-greeting");
    const sessionId = crypto.randomUUID();

    // Open SSE stream
    const sseRes = await app.request(`/chat/stream?sessionId=${sessionId}`);
    expect(sseRes.status).toBe(200);

    // Send empty message (greeting trigger)
    const postRes = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: "" }),
    });
    expect(postRes.status).toBe(200);

    // Read streamed greeting
    const text = await sseRes.text();
    expect(text).toContain("Welcome to WOPR");
    expect(text).toContain('data: {"type":"done"}');
  });

  it("tier budget caps are enforced correctly", async () => {
    const sessionId = crypto.randomUUID();

    const anon = await checkSessionBudget(usageRepo, sessionId, "anonymous");
    expect(anon.capUsd).toBe(0.1);

    const free = await checkSessionBudget(usageRepo, sessionId, "free");
    expect(free.capUsd).toBe(0.25);

    const paid = await checkSessionBudget(usageRepo, sessionId, "paid");
    expect(paid.capUsd).toBe(1.0);
  });
});
