/**
 * Tests for per-instance circuit breaker middleware.
 */

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { circuitBreaker, getCircuitStates } from "./circuit-breaker.js";
import type { GatewayTenant } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTenant(id: string, instanceId?: string): GatewayTenant {
  return { id, spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null }, instanceId };
}

function makeApp(config?: Parameters<typeof circuitBreaker>[0], instanceId?: string) {
  const app = new Hono<{ Variables: { gatewayTenant: GatewayTenant } }>();
  app.use("/*", (c, next) => {
    const tenantId = c.req.header("x-tenant-id") ?? "tenant-a";
    const instId = c.req.header("x-instance-id") ?? instanceId;
    c.set("gatewayTenant", makeTenant(tenantId, instId));
    return next();
  });
  app.use("/*", circuitBreaker(config));
  app.all("/*", (c) => c.json({ ok: true }, 200));
  return app;
}

type TestApp = ReturnType<typeof makeApp>;

async function sendRequests(app: TestApp, count: number, tenantId = "tenant-a", instanceId = "inst-a") {
  const results: Response[] = [];
  for (let i = 0; i < count; i++) {
    results.push(
      await app.request("/chat/completions", {
        method: "POST",
        headers: { "x-tenant-id": tenantId, "x-instance-id": instanceId },
      }),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("circuitBreaker", () => {
  it("stays closed (allows requests) under threshold", async () => {
    const app = makeApp({ maxRequestsPerWindow: 5, windowMs: 10_000 });
    const results = await sendRequests(app, 4);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it("trips the circuit at threshold and returns 429", async () => {
    const app = makeApp({ maxRequestsPerWindow: 3, windowMs: 10_000, pauseDurationMs: 300_000 });
    const results = await sendRequests(app, 4);
    // First 3 allowed, 4th triggers trip
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect(results[2].status).toBe(200);
    expect(results[3].status).toBe(429);
  });

  it("returns circuit_breaker_tripped error code when tripped", async () => {
    const app = makeApp({ maxRequestsPerWindow: 2, windowMs: 10_000, pauseDurationMs: 300_000 });
    await sendRequests(app, 2);
    const resp = await app.request("/chat/completions", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-a", "x-instance-id": "inst-a" },
    });
    expect(resp.status).toBe(429);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("circuit_breaker_tripped");
  });

  it("tripped circuit rejects all subsequent requests", async () => {
    const app = makeApp({ maxRequestsPerWindow: 2, windowMs: 10_000, pauseDurationMs: 300_000 });
    await sendRequests(app, 2); // reach threshold

    const results = await sendRequests(app, 3); // all should be 429
    expect(results.every((r) => r.status === 429)).toBe(true);
  });

  it("circuit auto-resets after pauseDurationMs", async () => {
    vi.useFakeTimers();
    const app = makeApp({ maxRequestsPerWindow: 2, windowMs: 10_000, pauseDurationMs: 300_000 });
    await sendRequests(app, 2);
    // Trip the circuit
    let resp = await app.request("/chat/completions", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-a", "x-instance-id": "inst-a" },
    });
    expect(resp.status).toBe(429);

    // Advance past pause duration
    vi.advanceTimersByTime(300_001);

    // Should be allowed again
    resp = await app.request("/chat/completions", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-a", "x-instance-id": "inst-a" },
    });
    expect(resp.status).toBe(200);

    vi.useRealTimers();
  });

  it("onTrip callback fires exactly once per trip", async () => {
    const onTrip = vi.fn();
    const app = makeApp({ maxRequestsPerWindow: 2, windowMs: 10_000, pauseDurationMs: 300_000, onTrip });
    await sendRequests(app, 2); // reach threshold

    // Trip + several more requests
    await sendRequests(app, 3);
    // onTrip should only fire once (on the trip), not on subsequent blocked requests
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip).toHaveBeenCalledWith("tenant-a", "inst-a", expect.any(Number));
  });

  it("different instances have independent circuits", async () => {
    const app = makeApp({ maxRequestsPerWindow: 2, windowMs: 10_000, pauseDurationMs: 300_000 });
    // Trip instance A
    await sendRequests(app, 3, "tenant-a", "inst-a");

    // Instance B should still be fine
    const resp = await app.request("/chat/completions", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-a", "x-instance-id": "inst-b" },
    });
    expect(resp.status).toBe(200);
  });

  it("falls back to tenantId when instanceId is absent", async () => {
    const onTrip = vi.fn();
    // No instanceId header, no instanceId in tenant
    const app = makeApp({ maxRequestsPerWindow: 2, windowMs: 10_000, pauseDurationMs: 300_000, onTrip });

    for (let i = 0; i < 3; i++) {
      await app.request("/chat/completions", {
        method: "POST",
        headers: { "x-tenant-id": "tenant-fallback" },
        // deliberately no x-instance-id header
      });
    }

    // Should have tripped using tenantId as key
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip).toHaveBeenCalledWith("tenant-fallback", "tenant-fallback", expect.any(Number));
  });

  it("includes Retry-After header in 429 response", async () => {
    const app = makeApp({ maxRequestsPerWindow: 2, windowMs: 10_000, pauseDurationMs: 300_000 });
    await sendRequests(app, 2);
    const resp = await app.request("/chat/completions", {
      method: "POST",
      headers: { "x-tenant-id": "tenant-a", "x-instance-id": "inst-a" },
    });
    expect(resp.status).toBe(429);
    const retryAfter = resp.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBe(300); // 300_000ms / 1000
  });

  it("getCircuitStates returns state after circuit trips", async () => {
    const app = makeApp({ maxRequestsPerWindow: 2, windowMs: 10_000, pauseDurationMs: 300_000 });
    await sendRequests(app, 3, "tenant-states", "inst-states");

    const states = getCircuitStates();
    const entry = states.get("inst-states");
    expect(entry).toBeDefined();
    expect(entry?.trippedAt).not.toBeNull();
    expect(entry?.remainingPauseMs).toBeGreaterThan(0);
  });
});
