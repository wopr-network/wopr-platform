/**
 * Tests for Zod validation in webhook proxy handlers.
 *
 * Focuses on duration_minutes cap and required field validation.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { GatewayAuthEnv } from "./service-key-auth.js";
import type { GatewayTenant } from "./types.js";

const TEST_TENANT: GatewayTenant = {
  id: "tenant-test",
  spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
};

// Lazy import after setting up mocks
async function buildProxyApp() {
  const { phoneInbound, smsInbound, smsDeliveryStatus, buildProxyDeps } = await import("./proxy.js");

  const mockMeter = { emit: () => {} };
  const mockBudget = { check: async () => ({ allowed: true }) };

  const deps = buildProxyDeps({
    meter: mockMeter as never,
    budgetChecker: mockBudget as never,
    providers: {},
    resolveServiceKey: () => TEST_TENANT,
  });

  const app = new Hono<GatewayAuthEnv>();

  // Pre-set tenant so handlers don't need auth middleware
  app.use("/*", async (c, next) => {
    c.set("gatewayTenant", TEST_TENANT);
    await next();
  });

  app.post("/phone/inbound", phoneInbound(deps));
  app.post("/messages/sms/inbound", smsInbound(deps));
  app.post("/messages/sms/status", smsDeliveryStatus(deps));

  return app;
}

describe("phoneInbound Zod validation", () => {
  it("accepts valid body with duration_minutes within cap", async () => {
    const app = await buildProxyApp();
    const res = await app.request("/phone/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_sid: "CA123", duration_minutes: 5, status: "completed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { duration_minutes: number };
    expect(body.duration_minutes).toBe(5);
  });

  it("rejects duration_minutes exceeding 240 cap", async () => {
    const app = await buildProxyApp();
    const res = await app.request("/phone/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration_minutes: 500 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects negative duration_minutes", async () => {
    const app = await buildProxyApp();
    const res = await app.request("/phone/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration_minutes: -1 }),
    });
    expect(res.status).toBe(400);
  });

  it("defaults duration_minutes to 1 when absent", async () => {
    const app = await buildProxyApp();
    const res = await app.request("/phone/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_sid: "CA456" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { duration_minutes: number };
    expect(body.duration_minutes).toBe(1);
  });
});

describe("smsInbound Zod validation", () => {
  it("accepts valid SMS inbound body", async () => {
    const app = await buildProxyApp();
    const res = await app.request("/messages/sms/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message_sid: "SM123",
        from: "+15005550006",
        to: "+15005550001",
        body: "Hello",
      }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects SMS inbound with missing required fields", async () => {
    const app = await buildProxyApp();
    const res = await app.request("/messages/sms/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_sid: "SM123" }), // missing from, to, body
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });
});

describe("smsDeliveryStatus Zod validation", () => {
  it("accepts valid delivery status body", async () => {
    const app = await buildProxyApp();
    const res = await app.request("/messages/sms/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_sid: "SM123", message_status: "delivered" }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects delivery status with missing message_sid", async () => {
    const app = await buildProxyApp();
    const res = await app.request("/messages/sms/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_status: "delivered" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });
});
