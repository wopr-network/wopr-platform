import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCreditAdjustmentSchema } from "../../admin/credits/schema.js";
import { createDb, type DrizzleDb } from "../../db/index.js";
import type { BotProfile, BotStatus } from "../../fleet/types.js";
import { CreditLedger } from "../../monetization/credits/credit-ledger.js";
import { initCreditSchema } from "../../monetization/credits/schema.js";
import { initMeterSchema } from "../../monetization/metering/schema.js";
import { initStripeSchema } from "../../monetization/stripe/schema.js";
import { TenantCustomerStore } from "../../monetization/stripe/tenant-store.js";
import { handleWebhookEvent } from "../../monetization/stripe/webhook.js";

// ---------------------------------------------------------------------------
// Shared test token and auth header
// ---------------------------------------------------------------------------

const TEST_TOKEN = "test-api-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };
const jsonAuth = { "Content-Type": "application/json", ...authHeader };

// ---------------------------------------------------------------------------
// Fleet mocks (shared across deployment and management flows)
// ---------------------------------------------------------------------------

const createdBots = new Map<string, BotProfile>();
let botRunningState = new Map<string, boolean>();

/** Counter-based deterministic UUID generator for tests. */
let botCounter = 0;
function nextBotUuid(): string {
  botCounter++;
  return `00000000-0000-4000-8000-${String(botCounter).padStart(12, "0")}`;
}

const mockProfile: BotProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  tenantId: "user-123",
  name: "my-discord-bot",
  description: "E2E test bot",
  image: "ghcr.io/wopr-network/wopr:stable",
  env: { DISCORD_TOKEN: "secret-token" },
  restartPolicy: "unless-stopped",
  releaseChannel: "stable",
  updatePolicy: "manual",
};

function makeBotStatus(profile: BotProfile, running: boolean): BotStatus {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    image: profile.image,
    containerId: running ? `container-${profile.id}` : null,
    state: running ? "running" : "stopped",
    health: running ? "healthy" : null,
    uptime: running ? "2026-01-01T00:00:00Z" : null,
    startedAt: running ? "2026-01-01T00:00:00Z" : null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    stats: running ? { cpuPercent: 2.5, memoryUsageMb: 128, memoryLimitMb: 512, memoryPercent: 25 } : null,
  };
}

class MockBotNotFoundError extends Error {
  constructor(id: string) {
    super(`Bot not found: ${id}`);
    this.name = "BotNotFoundError";
  }
}

const fleetMock = {
  create: vi.fn().mockImplementation(async (data: { name: string; image: string }) => {
    const profile: BotProfile = {
      ...mockProfile,
      id: nextBotUuid(),
      name: data.name,
      image: data.image,
    };
    createdBots.set(profile.id, profile);
    botRunningState.set(profile.id, false);
    return profile;
  }),
  start: vi.fn().mockImplementation(async (id: string) => {
    if (!createdBots.has(id)) throw new MockBotNotFoundError(id);
    botRunningState.set(id, true);
  }),
  stop: vi.fn().mockImplementation(async (id: string) => {
    if (!createdBots.has(id)) throw new MockBotNotFoundError(id);
    botRunningState.set(id, false);
  }),
  restart: vi.fn().mockImplementation(async (id: string) => {
    if (!createdBots.has(id)) throw new MockBotNotFoundError(id);
    botRunningState.set(id, true);
  }),
  remove: vi.fn().mockImplementation(async (id: string) => {
    if (!createdBots.has(id)) throw new MockBotNotFoundError(id);
    createdBots.delete(id);
    botRunningState.delete(id);
  }),
  status: vi.fn().mockImplementation(async (id: string) => {
    const profile = createdBots.get(id);
    if (!profile) throw new MockBotNotFoundError(id);
    return makeBotStatus(profile, botRunningState.get(id) ?? false);
  }),
  listAll: vi.fn().mockImplementation(async () => {
    return Array.from(createdBots.entries()).map(([id, profile]) =>
      makeBotStatus(profile, botRunningState.get(id) ?? false),
    );
  }),
  logs: vi.fn().mockImplementation(async (id: string) => {
    if (!createdBots.has(id)) throw new MockBotNotFoundError(id);
    return "2026-01-15T10:00:00Z [INFO] Bot started\n2026-01-15T10:00:01Z [INFO] Connected to Discord";
  }),
  update: vi.fn().mockImplementation(async (id: string, data: Partial<BotProfile>) => {
    const profile = createdBots.get(id);
    if (!profile) throw new MockBotNotFoundError(id);
    const updated = { ...profile, ...data };
    createdBots.set(id, updated);
    return updated;
  }),
  profiles: {
    get: vi.fn().mockImplementation(async (id: string) => {
      return createdBots.get(id) ?? null;
    }),
  },
};

const updaterMock = {
  updateBot: vi.fn().mockImplementation(async (id: string) => {
    const profile = createdBots.get(id);
    if (!profile)
      return {
        botId: id,
        success: false,
        error: "Bot not found",
        previousImage: "",
        newImage: "",
        previousDigest: null,
        newDigest: null,
        rolledBack: false,
      };
    return {
      botId: id,
      success: true,
      previousImage: profile.image,
      newImage: profile.image,
      previousDigest: "sha256:olddigest",
      newDigest: "sha256:newdigest",
      rolledBack: false,
    };
  }),
};

const pollerMock = {
  getImageStatus: vi.fn().mockImplementation((_id: string, profile: BotProfile) => ({
    botId: profile.id,
    currentDigest: "sha256:olddigest",
    availableDigest: "sha256:newdigest",
    updateAvailable: true,
    releaseChannel: profile.releaseChannel,
    updatePolicy: profile.updatePolicy,
    lastCheckedAt: "2026-01-15T10:00:00Z",
  })),
  onUpdateAvailable: null as ((botId: string, digest: string) => Promise<void>) | null,
};

// ---------------------------------------------------------------------------
// Module mocks — set up before importing fleet routes
// ---------------------------------------------------------------------------

vi.mock("dockerode", () => {
  return { default: class MockDocker {} };
});

vi.mock("../../fleet/profile-store.js", () => {
  return { ProfileStore: class MockProfileStore {} };
});

vi.mock("../../fleet/fleet-manager.js", () => {
  return {
    FleetManager: class {
      create = fleetMock.create;
      start = fleetMock.start;
      stop = fleetMock.stop;
      restart = fleetMock.restart;
      remove = fleetMock.remove;
      status = fleetMock.status;
      listAll = fleetMock.listAll;
      logs = fleetMock.logs;
      update = fleetMock.update;
      profiles = fleetMock.profiles;
    },
    BotNotFoundError: MockBotNotFoundError,
  };
});

vi.mock("../../fleet/image-poller.js", () => {
  return {
    ImagePoller: class {
      getImageStatus = pollerMock.getImageStatus;
      onUpdateAvailable = pollerMock.onUpdateAvailable;
    },
  };
});

vi.mock("../../fleet/updater.js", () => {
  return {
    ContainerUpdater: class {
      updateBot = updaterMock.updateBot;
    },
  };
});

vi.mock("../../network/network-policy.js", () => {
  return {
    NetworkPolicy: class {
      prepareForContainer = vi.fn().mockResolvedValue("wopr-tenant-mock");
      cleanupAfterRemoval = vi.fn().mockResolvedValue(undefined);
    },
  };
});

// Import AFTER mocks
const { fleetRoutes } = await import("./fleet.js");
const { billingRoutes, setBillingDeps } = await import("./billing.js");
const { quotaRoutes, setLedger } = await import("./quota.js");
const { healthRoutes } = await import("./health.js");

// ---------------------------------------------------------------------------
// Build the full app — same as the real app.ts mounting
// ---------------------------------------------------------------------------

function buildApp() {
  const a = new Hono();
  a.route("/health", healthRoutes);
  a.route("/fleet", fleetRoutes);
  a.route("/api/quota", quotaRoutes);
  a.route("/api/billing", billingRoutes);
  return a;
}

// ---------------------------------------------------------------------------
// E2E: Bot Deployment Flow
// ---------------------------------------------------------------------------

describe("E2E: Bot deployment flow", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    createdBots.clear();
    botRunningState = new Map();
    botCounter = 0;
    app = buildApp();
  });

  it("Auth -> create bot -> start -> verify running -> health check -> view logs", async () => {
    // Step 0: Verify auth is enforced — no token should fail
    const noAuthRes = await app.request("/fleet/bots", { method: "POST" });
    expect(noAuthRes.status).toBe(401);

    // Step 1: Create a new bot instance
    const createRes = await app.request("/fleet/bots", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        tenantId: "user-123",
        name: "my-discord-bot",
        image: "ghcr.io/wopr-network/wopr:stable",
        env: { DISCORD_TOKEN: "secret-token" },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.name).toBe("my-discord-bot");
    expect(created.id).toMatch(/^[a-f0-9-]{36}$/);
    const botId = created.id;

    // Step 2: Verify the bot appears in the list (initially stopped)
    const listRes = await app.request("/fleet/bots", { headers: authHeader });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.bots).toHaveLength(1);
    expect(listBody.bots[0].state).toBe("stopped");

    // Step 3: Start the bot
    const startRes = await app.request(`/fleet/bots/${botId}/start`, {
      method: "POST",
      headers: authHeader,
    });
    expect(startRes.status).toBe(200);

    // Step 4: Verify the bot is now running
    const statusRes = await app.request(`/fleet/bots/${botId}`, { headers: authHeader });
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status.state).toBe("running");
    expect(status.health).toBe("healthy");
    expect(status.containerId).toBe(`container-${botId}`);
    expect(status.stats).toBeDefined();
    expect(status.stats.cpuPercent).toBeGreaterThan(0);

    // Step 5: Check platform health endpoint (always available, no auth)
    const healthRes = await app.request("/health");
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json();
    expect(healthBody.status).toBe("ok");

    // Step 6: View bot logs
    const logsRes = await app.request(`/fleet/bots/${botId}/logs`, { headers: authHeader });
    expect(logsRes.status).toBe(200);
    const logs = await logsRes.text();
    expect(logs).toContain("Bot started");
    expect(logs).toContain("Connected to Discord");
  });
});

// ---------------------------------------------------------------------------
// E2E: Bot Management Flow
// ---------------------------------------------------------------------------

describe("E2E: Bot management flow", () => {
  let app: Hono;
  let botId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    createdBots.clear();
    botRunningState = new Map();
    botCounter = 0;
    app = buildApp();

    // Pre-create a running bot for management tests
    const createRes = await app.request("/fleet/bots", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        tenantId: "user-123",
        name: "managed-bot",
        image: "ghcr.io/wopr-network/wopr:stable",
      }),
    });
    const created = await createRes.json();
    botId = created.id;
    await app.request(`/fleet/bots/${botId}/start`, { method: "POST", headers: authHeader });
  });

  it("List -> status -> logs -> restart -> update image -> verify updated -> teardown", async () => {
    // Step 1: List all instances
    const listRes = await app.request("/fleet/bots", { headers: authHeader });
    expect(listRes.status).toBe(200);
    const bots = (await listRes.json()).bots;
    expect(bots).toHaveLength(1);
    expect(bots[0].name).toBe("managed-bot");
    expect(bots[0].state).toBe("running");

    // Step 2: View detailed status
    const statusRes = await app.request(`/fleet/bots/${botId}`, { headers: authHeader });
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status.state).toBe("running");
    expect(status.health).toBe("healthy");

    // Step 3: View logs
    const logsRes = await app.request(`/fleet/bots/${botId}/logs?tail=50`, {
      headers: authHeader,
    });
    expect(logsRes.status).toBe(200);
    const logs = await logsRes.text();
    expect(logs.length).toBeGreaterThan(0);

    // Step 4: Restart the bot
    const restartRes = await app.request(`/fleet/bots/${botId}/restart`, {
      method: "POST",
      headers: authHeader,
    });
    expect(restartRes.status).toBe(200);

    // Verify still running after restart
    const postRestartStatus = await app.request(`/fleet/bots/${botId}`, {
      headers: authHeader,
    });
    const postRestart = await postRestartStatus.json();
    expect(postRestart.state).toBe("running");

    // Step 5: Check image status (update available)
    const imageStatusRes = await app.request(`/fleet/bots/${botId}/image-status`, {
      headers: authHeader,
    });
    expect(imageStatusRes.status).toBe(200);
    const imageStatus = await imageStatusRes.json();
    expect(imageStatus.updateAvailable).toBe(true);
    expect(imageStatus.currentDigest).toBe("sha256:olddigest");
    expect(imageStatus.availableDigest).toBe("sha256:newdigest");

    // Step 6: Force update to latest image
    const updateRes = await app.request(`/fleet/bots/${botId}/update`, {
      method: "POST",
      headers: authHeader,
    });
    expect(updateRes.status).toBe(200);
    const updateResult = await updateRes.json();
    expect(updateResult.success).toBe(true);
    expect(updateResult.previousDigest).toBe("sha256:olddigest");
    expect(updateResult.newDigest).toBe("sha256:newdigest");

    // Step 7: Update bot configuration
    const patchRes = await app.request(`/fleet/bots/${botId}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ description: "Updated description" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.description).toBe("Updated description");

    // Step 8: Stop and teardown
    const stopRes = await app.request(`/fleet/bots/${botId}/stop`, {
      method: "POST",
      headers: authHeader,
    });
    expect(stopRes.status).toBe(200);

    // Verify stopped
    const stoppedStatus = await app.request(`/fleet/bots/${botId}`, { headers: authHeader });
    const stopped = await stoppedStatus.json();
    expect(stopped.state).toBe("stopped");

    // Delete the bot
    const deleteRes = await app.request(`/fleet/bots/${botId}?removeVolumes=true`, {
      method: "DELETE",
      headers: authHeader,
    });
    expect(deleteRes.status).toBe(204);

    // Verify it's gone
    const afterDeleteRes = await app.request(`/fleet/bots/${botId}`, { headers: authHeader });
    expect(afterDeleteRes.status).toBe(404);

    // Verify the list is empty
    const emptyList = await app.request("/fleet/bots", { headers: authHeader });
    const emptyBots = (await emptyList.json()).bots;
    expect(emptyBots).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// E2E: Billing Flow
// ---------------------------------------------------------------------------

describe("E2E: Billing flow (credit model)", () => {
  let app: Hono;
  let sqlite: BetterSqlite3.Database;
  let db: DrizzleDb;
  let tenantStore: TenantCustomerStore;
  let creditLedger: CreditLedger;

  const mockStripe = {
    checkout: {
      sessions: {
        create: vi.fn(),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(),
      },
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
  } as unknown as Stripe;

  beforeEach(() => {
    vi.clearAllMocks();
    createdBots.clear();
    botRunningState = new Map();
    botCounter = 0;

    // Set up in-memory DB with schemas
    sqlite = new BetterSqlite3(":memory:");
    initMeterSchema(sqlite);
    initStripeSchema(sqlite);
    initCreditAdjustmentSchema(sqlite);
    initCreditSchema(sqlite);
    db = createDb(sqlite);
    tenantStore = new TenantCustomerStore(db);
    creditLedger = new CreditLedger(db);

    // Inject credit ledger for quota routes
    setLedger(creditLedger);

    // Inject billing deps
    setBillingDeps({
      stripe: mockStripe,
      db,
      webhookSecret: "whsec_test",
    });

    app = buildApp();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("Credit checkout -> webhook credits ledger -> verify balance -> portal access", async () => {
    const tenantId = "tenant-e2e-1";

    // Step 1: Check initial quota (no credits yet — should show zero balance)
    const quotaRes = await app.request(`/api/quota?tenant=${tenantId}&activeInstances=0`, {
      headers: authHeader,
    });
    expect(quotaRes.status).toBe(200);
    const quota = await quotaRes.json();
    expect(quota.balanceCents).toBe(0);

    // Step 2: Verify zero balance blocks instance creation
    const quotaCheckRes = await app.request("/api/quota/check", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tenant: tenantId, activeInstances: 0 }),
    });
    expect(quotaCheckRes.status).toBe(402);
    const quotaCheck = await quotaCheckRes.json();
    expect(quotaCheck.allowed).toBe(false);

    // Step 3: Create a credit checkout session ($25 purchase)
    (mockStripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/cs_test_123",
    });

    const checkoutRes = await app.request("/api/billing/credits/checkout", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        tenant: tenantId,
        priceId: "price_credit_25",
        successUrl: "https://app.wopr.network/billing/success",
        cancelUrl: "https://app.wopr.network/billing/cancel",
      }),
    });
    expect(checkoutRes.status).toBe(200);
    const checkout = await checkoutRes.json();
    expect(checkout.url).toContain("checkout.stripe.com");
    expect(checkout.sessionId).toBe("cs_test_123");

    // Step 4: Simulate Stripe webhook — checkout.session.completed
    // (This creates the tenant-customer mapping and credits the ledger)
    const checkoutEvent = {
      type: "checkout.session.completed" as const,
      data: {
        object: {
          id: "cs_test_123",
          client_reference_id: tenantId,
          customer: "cus_e2e_123",
          amount_total: 2500,
          metadata: { wopr_tenant: tenantId },
        },
      },
    } as unknown as Stripe.Event;

    const webhookResult = handleWebhookEvent({ tenantStore, creditLedger }, checkoutEvent);
    expect(webhookResult.handled).toBe(true);
    expect(webhookResult.tenant).toBe(tenantId);
    expect(webhookResult.creditedCents).toBe(2500);

    // Step 5: Verify the tenant is now mapped to a Stripe customer
    const mapping = tenantStore.getByTenant(tenantId);
    expect(mapping).not.toBeNull();
    expect(mapping?.stripe_customer_id).toBe("cus_e2e_123");

    // Step 6: Verify credits were granted
    const balance = creditLedger.balance(tenantId);
    expect(balance).toBe(2500);

    // Step 7: Check balance via quota route
    const balanceRes = await app.request(`/api/quota/balance/${tenantId}`, {
      headers: authHeader,
    });
    expect(balanceRes.status).toBe(200);
    const balanceBody = await balanceRes.json();
    expect(balanceBody.balanceCents).toBe(2500);

    // Step 8: Access billing portal
    (mockStripe.billingPortal.sessions.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      url: "https://billing.stripe.com/session/portal_123",
    });

    const portalRes = await app.request("/api/billing/portal", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        tenant: tenantId,
        returnUrl: "https://app.wopr.network/settings",
      }),
    });
    expect(portalRes.status).toBe(200);
    const portal = await portalRes.json();
    expect(portal.url).toContain("billing.stripe.com");

    // Step 9: Make another credit purchase ($50)
    const secondCheckoutEvent = {
      type: "checkout.session.completed" as const,
      data: {
        object: {
          id: "cs_test_456",
          client_reference_id: tenantId,
          customer: "cus_e2e_123",
          amount_total: 5000,
          metadata: { wopr_tenant: tenantId },
        },
      },
    } as unknown as Stripe.Event;

    const secondResult = handleWebhookEvent({ tenantStore, creditLedger }, secondCheckoutEvent);
    expect(secondResult.handled).toBe(true);
    expect(secondResult.creditedCents).toBe(5000); // 1:1 without priceMap

    // Step 10: Verify accumulated balance
    const finalBalance = creditLedger.balance(tenantId);
    expect(finalBalance).toBe(7500); // 2500 + 5000
  });
});
