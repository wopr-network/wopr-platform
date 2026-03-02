import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { botMetricsMiddleware } from "./bot-metrics-middleware.js";
import { BotMetricsTracker } from "./bot-metrics-tracker.js";
import type { GatewayAuthEnv } from "./service-key-auth.js";

describe("botMetricsMiddleware", () => {
  it("records request with latency for tenant with instanceId", async () => {
    const tracker = new BotMetricsTracker();
    const app = new Hono<GatewayAuthEnv>();

    app.use("/*", async (c, next) => {
      c.set("gatewayTenant", {
        id: "tenant-1",
        spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
        instanceId: "bot-123",
      });
      return next();
    });
    app.use("/*", botMetricsMiddleware(tracker));
    app.post("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(200);

    const m = tracker.getMetrics("bot-123");
    expect(m).not.toBeNull();
    expect(m?.requestCount).toBe(1);
    expect(m?.errorCount).toBe(0);
    expect(m?.latencyP50Ms).toBeGreaterThanOrEqual(0);
  });

  it("skips recording when instanceId is missing", async () => {
    const tracker = new BotMetricsTracker();
    const app = new Hono<GatewayAuthEnv>();

    app.use("/*", async (c, next) => {
      c.set("gatewayTenant", {
        id: "tenant-1",
        spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
      });
      return next();
    });
    app.use("/*", botMetricsMiddleware(tracker));
    app.post("/test", (c) => c.json({ ok: true }));

    await app.request("/test", { method: "POST" });
    expect(tracker.getMetrics("bot-123")).toBeNull();
  });

  it("records error when downstream returns 4xx/5xx", async () => {
    const tracker = new BotMetricsTracker();
    const app = new Hono<GatewayAuthEnv>();

    app.use("/*", async (c, next) => {
      c.set("gatewayTenant", {
        id: "tenant-1",
        spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
        instanceId: "bot-err",
      });
      return next();
    });
    app.use("/*", botMetricsMiddleware(tracker));
    app.post("/test", (c) => c.json({ error: "bad" }, 500));

    await app.request("/test", { method: "POST" });
    const m = tracker.getMetrics("bot-err");
    if (m == null) throw new Error("expected metrics");
    expect(m.requestCount).toBe(1);
    expect(m.errorCount).toBe(1);
  });
});

describe("botMetricsMiddleware integration", () => {
  it("metrics accumulate across multiple requests", async () => {
    const tracker = new BotMetricsTracker();
    const app = new Hono<GatewayAuthEnv>();

    app.use("/*", async (c, next) => {
      c.set("gatewayTenant", {
        id: "tenant-1",
        spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
        instanceId: "bot-multi",
      });
      return next();
    });
    app.use("/*", botMetricsMiddleware(tracker));

    let callCount = 0;
    app.post("/test", (c) => {
      callCount++;
      if (callCount === 3) return c.json({ error: "fail" }, 502);
      return c.json({ ok: true });
    });

    for (let i = 0; i < 5; i++) {
      await app.request("/test", { method: "POST" });
    }

    const m = tracker.getMetrics("bot-multi");
    if (m == null) throw new Error("expected metrics");
    expect(m.requestCount).toBe(5);
    expect(m.errorCount).toBe(1);
    expect(m.latencyP50Ms).toBeGreaterThanOrEqual(0);
    expect(m.latencyP95Ms).toBeGreaterThanOrEqual(0);
  });
});
