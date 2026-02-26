/**
 * Tests for Twilio webhook authentication middleware.
 */

import crypto from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleSigPenaltyRepository } from "../api/drizzle-sig-penalty-repository.js";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import type { GatewayTenant } from "./types.js";
import { createTwilioWebhookAuth } from "./webhook-auth.js";

let db: DrizzleDb;
let pool: PGlite;

function makeTestSigPenaltyRepo() {
  return new DrizzleSigPenaltyRepository(db);
}

const TEST_AUTH_TOKEN = "test-auth-token-12345";
const TEST_WEBHOOK_BASE_URL = "https://api.wopr.network/v1";
const TEST_TENANT: GatewayTenant = {
  id: "tenant-abc",
  spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
};

function computeSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return crypto.createHmac("sha1", authToken).update(data).digest("base64");
}

function buildTestApp(resolveTenant: (c: import("hono").Context) => GatewayTenant | null = () => TEST_TENANT) {
  const app = new Hono();
  const webhookAuth = createTwilioWebhookAuth({
    twilioAuthToken: TEST_AUTH_TOKEN,
    webhookBaseUrl: TEST_WEBHOOK_BASE_URL,
    resolveTenantFromWebhook: resolveTenant,
    sigPenaltyRepo: makeTestSigPenaltyRepo(),
  });

  app.post("/v1/phone/inbound/:tenantId", webhookAuth, (c) => {
    return c.json({ ok: true, tenantId: c.get("gatewayTenant")?.id });
  });

  return app;
}

describe("createTwilioWebhookAuth", () => {
  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterEach(async () => {
    await pool.close();
  });

  it("returns 400 when X-Twilio-Signature header is missing", async () => {
    const app = buildTestApp();
    const res = await app.request("/v1/phone/inbound/tenant-abc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/missing/i);
  });

  it("returns 400 when X-Twilio-Signature is invalid", async () => {
    const app = buildTestApp();
    const res = await app.request("/v1/phone/inbound/tenant-abc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twilio-Signature": "invalidsignature==",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid/i);
  });

  it("passes through with valid signature and sets gatewayTenant", async () => {
    const app = buildTestApp();
    const url = `${TEST_WEBHOOK_BASE_URL}/phone/inbound/tenant-abc`;
    const params = { CallSid: "CA123", From: "+15005550006", To: "+15005550001" };
    const signature = computeSignature(TEST_AUTH_TOKEN, url, params);

    const res = await app.request("/v1/phone/inbound/tenant-abc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twilio-Signature": signature,
      },
      body: JSON.stringify(params),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tenantId: string };
    expect(body.ok).toBe(true);
    expect(body.tenantId).toBe("tenant-abc");
  });

  it("returns 401 when tenant cannot be resolved", async () => {
    const app = buildTestApp(() => null);
    const url = `${TEST_WEBHOOK_BASE_URL}/phone/inbound/unknown-tenant`;
    const signature = computeSignature(TEST_AUTH_TOKEN, url, {});

    const res = await app.request("/v1/phone/inbound/unknown-tenant", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twilio-Signature": signature,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("applies exponential backoff after repeated failures from same IP", async () => {
    const app = buildTestApp();
    // Send 6 invalid requests from same IP
    for (let i = 0; i < 6; i++) {
      await app.request("/v1/phone/inbound/tenant-abc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Twilio-Signature": "badsig==",
          "X-Forwarded-For": "10.0.0.1",
        },
        body: JSON.stringify({}),
      });
    }
    // After enough failures, should get 429
    const res = await app.request("/v1/phone/inbound/tenant-abc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twilio-Signature": "badsig==",
        "X-Forwarded-For": "10.0.0.1",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(429);
  });

  it("does not penalize different IPs for each other's failures", async () => {
    const app = buildTestApp();
    // Send many failures from IP A
    for (let i = 0; i < 10; i++) {
      await app.request("/v1/phone/inbound/tenant-abc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Twilio-Signature": "badsig==",
          "X-Forwarded-For": "10.0.0.2",
        },
        body: JSON.stringify({}),
      });
    }

    // IP B with valid signature should still get through
    const url = `${TEST_WEBHOOK_BASE_URL}/phone/inbound/tenant-abc`;
    const params = {};
    const signature = computeSignature(TEST_AUTH_TOKEN, url, params);
    const res = await app.request("/v1/phone/inbound/tenant-abc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twilio-Signature": signature,
        "X-Forwarded-For": "192.168.1.1",
      },
      body: JSON.stringify(params),
    });
    expect(res.status).toBe(200);
  });
});
