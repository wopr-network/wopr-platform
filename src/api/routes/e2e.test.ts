import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotProfile, BotStatus } from "../../fleet/types.js";
import { initMeterSchema } from "../../monetization/metering/schema.js";
import { TierStore } from "../../monetization/quotas/tier-definitions.js";
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

const mockProfile: BotProfile = {
  id: "bot-deploy-1",
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
      id: `bot-${data.name}`,
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

// Import AFTER mocks
const { fleetRoutes } = await import("./fleet.js");
const { billingRoutes, setBillingDeps } = await import("./billing.js");
const { quotaRoutes, setTierStore } = await import("./quota.js");
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
        name: "my-discord-bot",
        image: "ghcr.io/wopr-network/wopr:stable",
        env: { DISCORD_TOKEN: "secret-token" },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.name).toBe("my-discord-bot");
    expect(created.id).toBe("bot-my-discord-bot");
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
    app = buildApp();

    // Pre-create a running bot for management tests
    const createRes = await app.request("/fleet/bots", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
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

describe("E2E: Billing flow", () => {
  let app: Hono;
  let db: BetterSqlite3.Database;
  let tenantStore: TenantCustomerStore;
  let tierStore: TierStore;

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

    // Set up in-memory DB with schemas
    db = new BetterSqlite3(":memory:");
    initMeterSchema(db);
    initStripeSchema(db);
    tenantStore = new TenantCustomerStore(db);

    // Set up tier store
    tierStore = new TierStore(db);
    tierStore.seed();
    setTierStore(tierStore);

    // Inject billing deps
    setBillingDeps({
      stripe: mockStripe,
      db,
      webhookSecret: "whsec_test",
      defaultPriceId: "price_default",
    });

    app = buildApp();
  });

  afterEach(() => {
    db.close();
  });

  it("Checkout -> webhook confirms subscription -> verify quota upgraded -> portal -> cancel -> verify downgrade", async () => {
    const tenantId = "tenant-e2e-1";

    // Step 1: Check initial quota (free tier — 1 instance max)
    const freeQuotaRes = await app.request(`/api/quota?tier=free&activeInstances=0`, {
      headers: authHeader,
    });
    expect(freeQuotaRes.status).toBe(200);
    const freeQuota = await freeQuotaRes.json();
    expect(freeQuota.tier.id).toBe("free");
    expect(freeQuota.instances.max).toBe(1);
    expect(freeQuota.instances.remaining).toBe(1);

    // Step 2: Verify free tier blocks creating more than 1 instance
    const quotaCheckRes = await app.request("/api/quota/check", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tier: "free", activeInstances: 1 }),
    });
    expect(quotaCheckRes.status).toBe(403);
    const quotaCheck = await quotaCheckRes.json();
    expect(quotaCheck.allowed).toBe(false);

    // Step 3: Create a checkout session to upgrade to pro
    (mockStripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/cs_test_123",
    });

    const checkoutRes = await app.request("/api/billing/checkout", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        tenant: tenantId,
        priceId: "price_pro_monthly",
        successUrl: "https://app.wopr.network/billing/success",
        cancelUrl: "https://app.wopr.network/billing/cancel",
      }),
    });
    expect(checkoutRes.status).toBe(200);
    const checkout = await checkoutRes.json();
    expect(checkout.url).toContain("checkout.stripe.com");
    expect(checkout.sessionId).toBe("cs_test_123");

    // Step 4: Simulate Stripe webhook — checkout.session.completed
    // (This creates the tenant-customer mapping in the DB)
    const checkoutEvent = {
      type: "checkout.session.completed" as const,
      data: {
        object: {
          client_reference_id: tenantId,
          customer: "cus_e2e_123",
          subscription: "sub_e2e_456",
          metadata: { wopr_tenant: tenantId },
        },
      },
    } as unknown as Stripe.Event;

    const webhookResult = handleWebhookEvent(tenantStore, checkoutEvent);
    expect(webhookResult.handled).toBe(true);
    expect(webhookResult.tenant).toBe(tenantId);

    // Step 5: Verify the tenant is now mapped to a Stripe customer
    const mapping = tenantStore.getByTenant(tenantId);
    expect(mapping).not.toBeNull();
    expect(mapping?.stripe_customer_id).toBe("cus_e2e_123");
    expect(mapping?.stripe_subscription_id).toBe("sub_e2e_456");

    // Step 6: Upgrade the tenant's tier in the store
    tenantStore.setTier(tenantId, "pro");
    const updatedMapping = tenantStore.getByTenant(tenantId);
    expect(updatedMapping?.tier).toBe("pro");

    // Step 7: Check pro tier quota — should allow 5 instances
    const proQuotaRes = await app.request(`/api/quota?tier=pro&activeInstances=1`, {
      headers: authHeader,
    });
    expect(proQuotaRes.status).toBe(200);
    const proQuota = await proQuotaRes.json();
    expect(proQuota.tier.id).toBe("pro");
    expect(proQuota.instances.max).toBe(5);
    expect(proQuota.instances.remaining).toBe(4);

    // Step 8: Verify pro tier allows creating more instances
    const proCheckRes = await app.request("/api/quota/check", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tier: "pro", activeInstances: 1 }),
    });
    expect(proCheckRes.status).toBe(200);
    const proCheck = await proCheckRes.json();
    expect(proCheck.allowed).toBe(true);

    // Step 9: List available tiers
    const tiersRes = await app.request("/api/quota/tiers", { headers: authHeader });
    expect(tiersRes.status).toBe(200);
    const tiersBody = await tiersRes.json();
    expect(tiersBody.tiers.length).toBeGreaterThanOrEqual(4);
    const tierIds = tiersBody.tiers.map((t: { id: string }) => t.id);
    expect(tierIds).toContain("free");
    expect(tierIds).toContain("pro");
    expect(tierIds).toContain("team");
    expect(tierIds).toContain("enterprise");

    // Step 10: Get resource limits for pro tier
    const limitsRes = await app.request("/api/quota/resource-limits/pro", {
      headers: authHeader,
    });
    expect(limitsRes.status).toBe(200);
    const limits = await limitsRes.json();
    expect(limits.Memory).toBe(2048 * 1024 * 1024); // 2GB
    expect(limits.CpuQuota).toBe(200_000);

    // Step 11: Access billing portal
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

    // Step 12: Simulate subscription cancellation via webhook
    const cancelEvent = {
      type: "customer.subscription.deleted" as const,
      data: {
        object: {
          id: "sub_e2e_456",
          customer: "cus_e2e_123",
        },
      },
    } as unknown as Stripe.Event;

    const cancelResult = handleWebhookEvent(tenantStore, cancelEvent);
    expect(cancelResult.handled).toBe(true);
    expect(cancelResult.tenant).toBe(tenantId);

    // Step 13: Verify tenant is downgraded to free tier
    const downgradedMapping = tenantStore.getByTenant(tenantId);
    expect(downgradedMapping?.tier).toBe("free");
    expect(downgradedMapping?.stripe_subscription_id).toBeNull();

    // Step 14: Verify free tier quota is enforced again
    const downgradeQuotaRes = await app.request(`/api/quota?tier=free&activeInstances=1`, {
      headers: authHeader,
    });
    expect(downgradeQuotaRes.status).toBe(200);
    const downgradeQuota = await downgradeQuotaRes.json();
    expect(downgradeQuota.instances.remaining).toBe(0);

    // Step 15: Verify that creating more instances is blocked at free tier
    const blockedCheckRes = await app.request("/api/quota/check", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ tier: "free", activeInstances: 1 }),
    });
    expect(blockedCheckRes.status).toBe(403);
    const blockedCheck = await blockedCheckRes.json();
    expect(blockedCheck.allowed).toBe(false);
  });
});
