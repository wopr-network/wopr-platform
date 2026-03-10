/**
 * Integration tests for gateway route mounting (WOP-1621).
 *
 * Verifies all expected routes are reachable (non-404), auth middleware
 * is correctly applied, and route ordering is correct.
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

const VALID_KEY = "sk-test-route-mounting";

const TEST_TENANT: GatewayTenant = {
  id: "tenant-route-test",
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
        id: "test",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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

function authedRequest(app: ReturnType<typeof buildApp>, method: string, path: string, body?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${VALID_KEY}`,
    "Content-Type": "application/json",
  };
  return app.request(path, { method, headers, body });
}

function unauthedRequest(app: ReturnType<typeof buildApp>, method: string, path: string) {
  return app.request(path, { method });
}

// ---------------------------------------------------------------------------
// Route reachability — all routes return non-404 with valid auth
// ---------------------------------------------------------------------------

describe("gateway route mounting — reachability", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp(buildTestConfig());
  });

  const protectedPostRoutes = [
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/audio/transcriptions",
    "/v1/audio/speech",
    "/v1/images/generations",
    "/v1/video/generations",
    "/v1/phone/outbound",
    "/v1/phone/numbers",
    "/v1/messages/sms",
  ];

  it.each(protectedPostRoutes)("POST %s is reachable (non-404)", async (path) => {
    const res = await authedRequest(app, "POST", path, JSON.stringify({ model: "test", messages: [] }));
    expect(res.status).not.toBe(404);
  });

  it("GET /v1/phone/numbers is reachable (non-404)", async () => {
    const res = await authedRequest(app, "GET", "/v1/phone/numbers");
    expect(res.status).not.toBe(404);
  });

  it("DELETE /v1/phone/numbers/:id is reachable (non-404)", async () => {
    const res = await authedRequest(app, "DELETE", "/v1/phone/numbers/pn-123");
    expect(res.status).not.toBe(404);
  });

  it("GET /v1/models is reachable (non-404)", async () => {
    const res = await authedRequest(app, "GET", "/v1/models");
    expect(res.status).not.toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Auth middleware — protected routes reject unauthenticated requests
// ---------------------------------------------------------------------------

describe("gateway route mounting — auth enforcement", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp(buildTestConfig());
  });

  const protectedRoutes = [
    ["POST", "/v1/chat/completions"],
    ["POST", "/v1/completions"],
    ["POST", "/v1/embeddings"],
    ["POST", "/v1/audio/transcriptions"],
    ["POST", "/v1/audio/speech"],
    ["POST", "/v1/images/generations"],
    ["POST", "/v1/video/generations"],
    ["POST", "/v1/phone/outbound"],
    ["POST", "/v1/phone/numbers"],
    ["GET", "/v1/phone/numbers"],
    ["DELETE", "/v1/phone/numbers/pn-123"],
    ["POST", "/v1/messages/sms"],
    ["GET", "/v1/models"],
  ] as const;

  it.each(protectedRoutes)("%s %s returns 401 without auth", async (method, path) => {
    const res = await unauthedRequest(app, method, path);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("missing_api_key");
  });
});

// ---------------------------------------------------------------------------
// Public routes — no auth required
// ---------------------------------------------------------------------------

describe("gateway route mounting — public routes", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp(buildTestConfig());
  });

  it("GET /v1/phone/twiml/hangup is accessible without auth", async () => {
    const res = await unauthedRequest(app, "GET", "/v1/phone/twiml/hangup");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Route ordering — webhook routes registered before serviceKeyAuth wildcard
// ---------------------------------------------------------------------------

describe("gateway route mounting — webhook route ordering", () => {
  it("webhook routes are reachable when Twilio is fully configured", async () => {
    const sigPenaltyRepo = {
      get: vi.fn().mockResolvedValue(null),
      recordFailure: vi.fn().mockResolvedValue({ failures: 1, blockedUntil: 0 }),
      clear: vi.fn().mockResolvedValue(undefined),
      purgeStale: vi.fn().mockResolvedValue(0),
    };
    const config = buildTestConfig({
      providers: {
        openrouter: { apiKey: "or-test-key" },
        twilio: { accountSid: "AC-test", authToken: "twilio-auth-token" },
      },
      webhookBaseUrl: "https://api.test.example/v1",
      resolveTenantFromWebhook: () => TEST_TENANT,
      sigPenaltyRepo: sigPenaltyRepo as unknown as import("../api/sig-penalty-repository.js").ISigPenaltyRepository,
    });
    const app = buildApp(config);

    // Webhook routes use Twilio HMAC auth, not Bearer. They should NOT return 404.
    // They will return 401/403 (bad signature) but NOT 404.
    const webhookPaths = [
      "/v1/phone/inbound/tenant-1",
      "/v1/phone/outbound/status/tenant-1",
      "/v1/messages/sms/inbound/tenant-1",
      "/v1/messages/sms/status/tenant-1",
    ];

    for (const path of webhookPaths) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "test=1",
      });
      expect(res.status, `${path} should be 400 (Twilio HMAC missing sig, not 401/404)`).toBe(400);
    }
  });

  it("webhook routes return 401 when Twilio is NOT configured (wildcard auth catches them)", async () => {
    const config = buildTestConfig(); // no twilio config
    const app = buildApp(config);

    // Without Twilio config, webhook routes are not registered.
    // The serviceKeyAuth wildcard catches these paths and returns 401 (no Bearer).
    const res = await app.request("/v1/phone/inbound/tenant-1", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "test=1",
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Protocol sub-routes mounted
// ---------------------------------------------------------------------------

describe("gateway route mounting — protocol sub-routes", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp(buildTestConfig());
  });

  it("POST /v1/anthropic/... is mounted (non-404)", async () => {
    const res = await app.request("/v1/anthropic/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ model: "claude-3", messages: [] }),
    });
    expect(res.status).not.toBe(404);
  });

  it("POST /v1/openai/... is mounted (non-404)", async () => {
    const res = await app.request("/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "gpt-4", messages: [] }),
    });
    expect(res.status).not.toBe(404);
  });
});
