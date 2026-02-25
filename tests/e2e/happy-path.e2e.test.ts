/**
 * E2E: Happy Path
 *
 * Walks the full new-user journey end-to-end using real better-auth,
 * real credit ledger, real billing route, and a mocked fleet manager.
 *
 * Steps:
 *   1. Sign up
 *   2. Sign in → capture session cookie
 *   3. Check credits balance (0)
 *   4. Stripe webhook → credits land
 *   5. Verify credits balance (> 0)
 *   6. Create a bot via REST with bearer token
 *   7. Verify bot appears in list as stopped
 *
 * No Docker, no network, no Stripe API calls — only the fleet manager
 * and Stripe processor are mocked. Everything else is real code.
 */

import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db";
import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuth, resetAuth } from "../../src/auth/better-auth.js";
import { createDb } from "../../src/db/index.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { MeterAggregator } from "../../src/monetization/metering/aggregator.js";
import type { IPaymentProcessor } from "../../src/monetization/payment-processor.js";
import { TenantCustomerStore } from "../../src/monetization/stripe/tenant-store.js";
import { handleWebhookEvent } from "../../src/monetization/stripe/webhook.js";
import { initStripeSchema } from "../../src/monetization/stripe/schema.js";
import { initCreditSchema } from "../../src/monetization/credits/schema.js";
import { initMeterSchema } from "../../src/monetization/metering/schema.js";
import { initAffiliateSchema } from "../../src/monetization/affiliate/schema.js";
import { DrizzleAffiliateRepository } from "../../src/monetization/affiliate/drizzle-affiliate-repository.js";
import type { BotProfile, BotStatus } from "../../src/fleet/types.js";
import * as schema from "../../src/db/schema/index.js";
import { drizzle } from "drizzle-orm/better-sqlite3";

// ---------------------------------------------------------------------------
// Env vars that must be set BEFORE module-level code runs (fleet routes call
// buildTokenMetadataMap() at import time, which reads FLEET_API_TOKEN_WRITE).
// ---------------------------------------------------------------------------

vi.stubEnv("FLEET_API_TOKEN_WRITE", "wopr_write_e2e_test_token_abc");
vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_e2e_test_secret_for_happy_path");
vi.stubEnv("BETTER_AUTH_SECRET", "e2e-test-secret-happy-path");
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any dynamic imports
// ---------------------------------------------------------------------------

vi.mock("dockerode", () => ({ default: class MockDocker {} }));
vi.mock("../../src/fleet/profile-store.js", () => ({
  ProfileStore: class MockProfileStore {},
}));
vi.mock("../../src/proxy/singleton.js", () => ({
  getProxyManager: () => ({
    addRoute: vi.fn().mockResolvedValue(undefined),
    removeRoute: vi.fn(),
    updateHealth: vi.fn(),
  }),
  hydrateProxyRoutes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/network/network-policy.js", () => ({
  NetworkPolicy: class {
    prepareForContainer = vi.fn().mockResolvedValue("wopr-tenant-mock");
    cleanupAfterRemoval = vi.fn().mockResolvedValue(undefined);
  },
}));

// ---------------------------------------------------------------------------
// Fleet mock state — shared within a test
// ---------------------------------------------------------------------------

const createdBots = new Map<string, BotProfile>();
let botCounter = 0;

function nextBotId(): string {
  botCounter++;
  return `00000000-0000-4000-8000-${String(botCounter).padStart(12, "0")}`;
}

function makeStopped(profile: BotProfile): BotStatus {
  const now = new Date().toISOString();
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    image: profile.image,
    containerId: null,
    state: "stopped",
    health: null,
    uptime: null,
    startedAt: null,
    createdAt: now,
    updatedAt: now,
    stats: null,
  };
}

class MockBotNotFoundError extends Error {
  constructor(id: string) {
    super(`Bot not found: ${id}`);
    this.name = "BotNotFoundError";
  }
}

vi.mock("../../src/fleet/fleet-manager.js", () => ({
  FleetManager: class {
    async create(params: Omit<BotProfile, "id"> & { id?: string }): Promise<BotProfile> {
      const profile: BotProfile = { id: nextBotId(), ...params } as BotProfile;
      createdBots.set(profile.id, profile);
      return profile;
    }
    async start(id: string) {
      if (!createdBots.has(id)) throw new MockBotNotFoundError(id);
    }
    async stop(id: string) {
      if (!createdBots.has(id)) throw new MockBotNotFoundError(id);
    }
    async restart(id: string) {
      if (!createdBots.has(id)) throw new MockBotNotFoundError(id);
    }
    async remove(id: string) {
      if (!createdBots.has(id)) throw new MockBotNotFoundError(id);
      createdBots.delete(id);
    }
    async status(id: string): Promise<BotStatus> {
      const p = createdBots.get(id);
      if (!p) throw new MockBotNotFoundError(id);
      return makeStopped(p);
    }
    async listAll(): Promise<BotStatus[]> {
      return Array.from(createdBots.values()).map(makeStopped);
    }
    async listByTenant(tenantId: string): Promise<BotStatus[]> {
      return Array.from(createdBots.values())
        .filter((p) => p.tenantId === tenantId)
        .map(makeStopped);
    }
    async logs(id: string): Promise<string> {
      if (!createdBots.has(id)) throw new MockBotNotFoundError(id);
      return "2026-01-01T00:00:00Z [INFO] Bot started\n";
    }
    async update(id: string, updates: Partial<BotProfile>): Promise<BotProfile> {
      const p = createdBots.get(id);
      if (!p) throw new MockBotNotFoundError(id);
      const updated = { ...p, ...updates };
      createdBots.set(id, updated);
      return updated;
    }
    get profiles() {
      return {
        get: async (id: string) => createdBots.get(id) ?? null,
      };
    }
  },
  BotNotFoundError: MockBotNotFoundError,
}));

vi.mock("../../src/fleet/image-poller.js", () => ({
  ImagePoller: class {
    getImageStatus = vi.fn().mockReturnValue({ updateAvailable: false });
    onUpdateAvailable = null;
  },
}));

vi.mock("../../src/fleet/updater.js", () => ({
  ContainerUpdater: class {
    updateBot = vi.fn().mockResolvedValue({ success: true });
  },
}));

vi.mock("../../src/fleet/services.js", () => ({
  getRecoveryOrchestrator: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Lazy imports (after mocks are registered)
// ---------------------------------------------------------------------------

const { fleetRoutes } = await import("../../src/api/routes/fleet.js");
const { billingRoutes, setBillingDeps } = await import("../../src/api/routes/billing.js");
const { DrizzleSigPenaltyRepository } = await import(
  "../../src/api/drizzle-sig-penalty-repository.js"
);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_WRITE_TOKEN = "wopr_write_e2e_test_token_abc";
const AUTH_BASE = "http://localhost:3100";
const WEBHOOK_SECRET = "whsec_e2e_test_secret_for_happy_path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the session cookie from a set-cookie header. */
function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  // better-auth sets "better-auth.session_token=..." or "__Secure-better-auth.session_token=..."
  const match = setCookie.match(/((?:__Secure-)?better-auth\.session_token=[^;]+)/);
  return match?.[1] ?? "";
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E: happy path — signup → credits → bot creation", () => {
  let authSqlite: BetterSqlite3.Database;
  let platformSqlite: BetterSqlite3.Database;
  let sigSqlite: BetterSqlite3.Database;
  let creditLedger: CreditLedger;
  let tenantStore: TenantCustomerStore;
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    createdBots.clear();
    botCounter = 0;

    // ---- better-auth DB ----
    authSqlite = new BetterSqlite3(":memory:");
    const auth = betterAuth({
      database: authSqlite,
      secret: "e2e-test-secret-happy-path",
      baseURL: AUTH_BASE,
      basePath: "/api/auth",
      emailAndPassword: { enabled: true },
      trustedOrigins: [AUTH_BASE, "http://localhost:3000"],
    });
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    setAuth(auth as Parameters<typeof setAuth>[0]);

    // ---- platform DB (credits, billing) ----
    platformSqlite = new BetterSqlite3(":memory:");
    initMeterSchema(platformSqlite);
    initStripeSchema(platformSqlite);
    initCreditSchema(platformSqlite);
    initAffiliateSchema(platformSqlite);
    const db = createDb(platformSqlite);
    creditLedger = new CreditLedger(db);
    tenantStore = new TenantCustomerStore(db);

    // ---- sig-penalty DB ----
    sigSqlite = new BetterSqlite3(":memory:");
    sigSqlite.exec(`
      CREATE TABLE IF NOT EXISTS webhook_sig_penalties (
        ip TEXT NOT NULL,
        source TEXT NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (ip, source)
      );
    `);

    // ---- mock Stripe processor ----
    const mockProcessor: IPaymentProcessor = {
      name: "stripe-mock",
      supportsPortal: () => true,
      createCheckoutSession: vi.fn().mockResolvedValue({
        id: "cs_test_e2e",
        url: "https://checkout.stripe.com/cs_test_e2e",
      }),
      createPortalSession: vi.fn().mockResolvedValue({
        url: "https://billing.stripe.com/portal_e2e",
      }),
      handleWebhook: vi
        .fn()
        .mockImplementation((body: Buffer, _sig: string) => {
          // Parse the body to extract event details and pass through handleWebhookEvent
          const event = JSON.parse(body.toString()) as Parameters<typeof handleWebhookEvent>[1];
          const result = handleWebhookEvent({ tenantStore, creditLedger }, event);
          return Promise.resolve({
            handled: result.handled,
            eventType: event.type,
            tenant: result.tenant,
            creditedCents: result.creditedCents,
            duplicate: false,
          });
        }),
      setupPaymentMethod: vi.fn().mockResolvedValue({ clientSecret: "seti_test" }),
      listPaymentMethods: vi.fn().mockResolvedValue([]),
      detachPaymentMethod: vi.fn().mockResolvedValue(undefined),
      charge: vi.fn().mockResolvedValue({ success: true }),
    };

    setBillingDeps({
      processor: mockProcessor,
      creditLedger,
      meterAggregator: new MeterAggregator(db),
      sigPenaltyRepo: new DrizzleSigPenaltyRepository(
        drizzle(sigSqlite, { schema }),
      ),
      affiliateRepo: new DrizzleAffiliateRepository(db),
    });

    // ---- Hono app ----
    app = new Hono();

    // Auth routes — delegate to better-auth handler
    app.all("/api/auth/*", async (c) => {
      const { getAuth } = await import("../../src/auth/better-auth.js");
      return getAuth().handler(c.req.raw);
    });

    app.route("/billing", billingRoutes);
    app.route("/fleet", fleetRoutes);
  });

  afterEach(() => {
    resetAuth();
    authSqlite?.close();
    platformSqlite?.close();
    sigSqlite?.close();
  });

  it("signup → signin → webhook credits tenant → bot created", async () => {
    const email = `happy-${Date.now()}@wopr.bot`;
    const password = "HappyPath123!";

    // ----------------------------------------------------------------
    // Step 1: Sign up
    // ----------------------------------------------------------------
    const signupRes = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: "Happy User" }),
    });
    expect(signupRes.status, "signup").toBe(200);
    const signupBody = await signupRes.json();
    expect(signupBody.user?.email).toBe(email);
    const userId = signupBody.user?.id as string;
    expect(userId).toBeTruthy();

    // ----------------------------------------------------------------
    // Step 2: Sign in — capture session cookie
    // ----------------------------------------------------------------
    const signinRes = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(signinRes.status, "signin").toBe(200);
    const sessionCookie = extractSessionCookie(signinRes);
    expect(sessionCookie, "session cookie").not.toBe("");

    // ----------------------------------------------------------------
    // Step 3: Credits balance is 0 before any purchase
    // ----------------------------------------------------------------
    const preBalance = creditLedger.balance(userId);
    expect(preBalance, "initial balance").toBe(0);

    // ----------------------------------------------------------------
    // Step 4: Stripe webhook — checkout.session.completed → 500 credits
    // ----------------------------------------------------------------
    const checkoutEvent = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_e2e",
          client_reference_id: userId,
          customer: "cus_e2e_test",
          amount_total: 500,
          metadata: { wopr_tenant: userId },
        },
      },
    };

    const webhookBody = JSON.stringify(checkoutEvent);
    const webhookRes = await app.request("/billing/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "e2e-mock-sig",
        "x-forwarded-for": "127.0.0.1",
      },
      body: webhookBody,
    });
    expect(webhookRes.status, "webhook").toBe(200);
    const webhookResult = await webhookRes.json();
    expect(webhookResult.handled, "webhook handled").toBe(true);

    // ----------------------------------------------------------------
    // Step 5: Credits landed in the ledger
    // ----------------------------------------------------------------
    const postBalance = creditLedger.balance(userId);
    expect(postBalance, "balance after webhook").toBe(500);

    // ----------------------------------------------------------------
    // Step 6: Create a bot via REST bearer token
    // ----------------------------------------------------------------
    const createBotRes = await app.request("/fleet/bots", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_WRITE_TOKEN}`,
      },
      body: JSON.stringify({
        tenantId: userId,
        name: "happy-bot",
        image: "ghcr.io/wopr-network/wopr:latest",
        env: {},
        restartPolicy: "unless-stopped",
      }),
    });
    expect(createBotRes.status, "create bot").toBe(201);
    const bot = await createBotRes.json();
    expect(bot.name, "bot name").toBe("happy-bot");
    expect(bot.id, "bot id").toMatch(/^[a-f0-9-]{36}$/);
    const botId = bot.id as string;

    // ----------------------------------------------------------------
    // Step 7: Bot appears in list as stopped
    // ----------------------------------------------------------------
    const listRes = await app.request("/fleet/bots", {
      headers: { Authorization: `Bearer ${TEST_WRITE_TOKEN}` },
    });
    expect(listRes.status, "list bots").toBe(200);
    const listBody = await listRes.json();
    const created = (listBody.bots as BotStatus[]).find((b) => b.id === botId);
    expect(created, "bot in list").toBeDefined();
    expect(created?.state, "bot state").toBe("stopped");
    expect(created?.name, "bot name in list").toBe("happy-bot");
  });
});
