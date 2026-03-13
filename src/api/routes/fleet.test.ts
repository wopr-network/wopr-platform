import path from "node:path";
import { Credit } from "@wopr-network/platform-core/credits";
import type { INodeRepository } from "@wopr-network/platform-core/fleet/node-repository";
import type { ProfileTemplate } from "@wopr-network/platform-core/fleet/profile-schema";
import type { RecoveryOrchestrator } from "@wopr-network/platform-core/fleet/recovery-orchestrator";
import { getRecoveryOrchestrator } from "@wopr-network/platform-core/fleet/services";
import type { BotProfile, BotStatus } from "@wopr-network/platform-core/fleet/types";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Set env var BEFORE importing fleet routes so bearer auth uses this token
const TEST_TOKEN = "test-api-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);

// Tenant-scoped token for cross-tenant tests
const TENANT_TOKEN = "tenant-scoped-api-token";
vi.stubEnv("FLEET_TOKEN_user-123", `read:${TENANT_TOKEN}`);

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };

// --- Mock FleetManager ---

/** Stable UUIDs for test bots. */
const TEST_BOT_ID = "00000000-0000-4000-8000-000000000001";
/** A valid UUID for a bot that does not exist. */
const MISSING_BOT_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";

const mockProfile: BotProfile = {
  id: TEST_BOT_ID,
  tenantId: "user-123",
  name: "test-bot",
  description: "A test bot",
  image: "ghcr.io/wopr-network/wopr:stable",
  env: { TOKEN: "abc" },
  restartPolicy: "unless-stopped",
  releaseChannel: "stable",
  updatePolicy: "manual",
};

const mockStatus: BotStatus = {
  id: TEST_BOT_ID,
  name: "test-bot",
  description: "A test bot",
  image: "ghcr.io/wopr-network/wopr:stable",
  containerId: "container-123",
  state: "running",
  health: "healthy",
  uptime: "2026-01-01T00:00:00Z",
  startedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  stats: null,
  applicationMetrics: null,
};

class MockBotNotFoundError extends Error {
  constructor(id: string) {
    super(`Bot not found: ${id}`);
    this.name = "BotNotFoundError";
  }
}

const fleetMock = {
  create: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  remove: vi.fn(),
  status: vi.fn(),
  listAll: vi.fn(),
  listByTenant: vi.fn(),
  logs: vi.fn(),
  logStream: vi.fn(),
  update: vi.fn(),
  profiles: {
    get: vi.fn(),
    list: vi.fn(),
  },
};

const updaterMock = {
  updateBot: vi.fn(),
};

const pollerMock = {
  getImageStatus: vi.fn(),
  onUpdateAvailable: null as ((botId: string, digest: string) => Promise<void>) | null,
};

// Mock the modules before importing fleet routes
vi.mock("dockerode", () => {
  return { default: class MockDocker {} };
});

vi.mock("@wopr-network/platform-core/fleet/profile-store", () => {
  return { ProfileStore: class MockProfileStore {} };
});

vi.mock("@wopr-network/platform-core/fleet/fleet-manager", () => {
  return {
    FleetManager: class {
      create = fleetMock.create;
      start = fleetMock.start;
      stop = fleetMock.stop;
      restart = fleetMock.restart;
      remove = fleetMock.remove;
      status = fleetMock.status;
      listAll = fleetMock.listAll;
      listByTenant = fleetMock.listByTenant;
      logs = fleetMock.logs;
      logStream = fleetMock.logStream;
      update = fleetMock.update;
      profiles = fleetMock.profiles;
    },
    BotNotFoundError: MockBotNotFoundError,
  };
});

vi.mock("@wopr-network/platform-core/fleet/image-poller", () => {
  return {
    ImagePoller: class {
      getImageStatus = pollerMock.getImageStatus;
      onUpdateAvailable = pollerMock.onUpdateAvailable;
    },
  };
});

vi.mock("@wopr-network/platform-core/fleet/updater", () => {
  return {
    ContainerUpdater: class {
      updateBot = updaterMock.updateBot;
    },
  };
});

vi.mock("@wopr-network/platform-core/network/network-policy", () => {
  return {
    NetworkPolicy: class {
      prepareForContainer = vi.fn().mockResolvedValue("wopr-tenant-mock");
      cleanupAfterRemoval = vi.fn().mockResolvedValue(undefined);
    },
  };
});

// Mock credit ledger for balance checks
const creditLedgerMock = {
  balance: vi.fn(),
};

vi.mock("../../monetization/credits/credit-ledger.js", () => {
  return {
    CreditLedger: class {
      balance = creditLedgerMock.balance;
    },
  };
});

// Mock proxy singleton to avoid real DNS resolution in tests
vi.mock("@wopr-network/platform-core/proxy/singleton", () => {
  return {
    getProxyManager: () => ({
      addRoute: vi.fn().mockResolvedValue(undefined),
      removeRoute: vi.fn(),
      updateHealth: vi.fn(),
    }),
    hydrateProxyRoutes: vi.fn().mockResolvedValue(undefined),
  };
});

// Controllable getNodeRepo mock — default throws DATABASE_URL error (dev mode)
const mockGetNodeRepo = vi.fn((): INodeRepository => {
  throw new Error("DATABASE_URL environment variable is required");
});

// Controllable VPS repo mock — tests override getByBotId as needed
const mockVpsRepo = {
  getByBotId: vi.fn().mockResolvedValue(null),
};

// Controllable tenant customer repo mock — tests override getByTenant as needed
const mockTenantCustomerRepo = {
  getByTenant: vi.fn().mockResolvedValue(null),
};

// Mock services singletons to avoid DB connection at module load time (merged single vi.mock)
vi.mock("@wopr-network/platform-core/fleet/services", () => ({
  getNodeRepo: () => mockGetNodeRepo(),
  getRecoveryOrchestrator: vi.fn().mockReturnValue(null),
  getCommandBus: vi.fn().mockReturnValue(undefined),
  getBotInstanceRepo: vi.fn().mockReturnValue(undefined),
  getVpsRepo: () => mockVpsRepo,
  getTenantCustomerRepository: () => mockTenantCustomerRepo,
}));
// Dynamic import in fleet.ts uses the local path for functions not in platform-core
const mockServiceKeyRepo = {
  generate: vi.fn().mockResolvedValue("gw-key-abc123"),
  revokeByInstance: vi.fn().mockResolvedValue(undefined),
  resolve: vi.fn().mockResolvedValue(null),
};

vi.mock("../../fleet/services.js", () => ({
  getVpsRepo: () => mockVpsRepo,
  getTenantCustomerRepository: () => mockTenantCustomerRepo,
  getServiceKeyRepo: () => mockServiceKeyRepo,
}));

// Import AFTER mocks are set up
const { fleetRoutes, seedBots, setFleetDeps } = await import("./fleet.js");

const app = new Hono();
app.route("/fleet", fleetRoutes);

describe("fleet routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fleet profiles.list mock to default behavior
    fleetMock.profiles.list = vi.fn().mockResolvedValue([]);
    // Set up fleet.profiles.get to return the mock profile for TEST_BOT_ID, null for missing
    fleetMock.profiles.get = vi.fn().mockImplementation((id: string) => {
      if (id === TEST_BOT_ID) return Promise.resolve(mockProfile);
      return Promise.resolve(null);
    });

    // Set default credit ledger mock (tests can override as needed)
    creditLedgerMock.balance.mockResolvedValue(Credit.fromCents(1000)); // 1000 cents = $10

    setFleetDeps({
      creditLedger: creditLedgerMock as never,
      botBilling: {
        registerBot: vi.fn().mockResolvedValue(undefined),
        getActiveBotCount: vi.fn().mockResolvedValue(0),
        suspendBot: vi.fn(),
        suspendAllForTenant: vi.fn().mockResolvedValue([]),
        reactivateBot: vi.fn(),
        checkReactivation: vi.fn().mockResolvedValue([]),
        destroyBot: vi.fn(),
        destroyExpiredBots: vi.fn().mockResolvedValue([]),
        getBotBilling: vi.fn().mockResolvedValue(null),
        listForTenant: vi.fn().mockResolvedValue([]),
        getStorageTier: vi.fn().mockResolvedValue(null),
        setStorageTier: vi.fn(),
        getStorageTierCostsForTenant: vi.fn().mockResolvedValue(0),
      },
      emailVerifier: { isVerified: vi.fn().mockResolvedValue(true) },
    });
  });

  describe("authentication", () => {
    it("rejects requests without bearer token", async () => {
      const res = await app.request("/fleet/bots");
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await app.request("/fleet/bots", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /fleet/bots", () => {
    it("returns list of bots", async () => {
      fleetMock.listAll.mockResolvedValue([mockStatus]);

      const res = await app.request("/fleet/bots", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bots).toHaveLength(1);
      expect(body.bots[0].name).toBe("test-bot");
    });

    it("returns empty list when no bots", async () => {
      fleetMock.listAll.mockResolvedValue([]);

      const res = await app.request("/fleet/bots", { headers: authHeader });
      const body = await res.json();
      expect(body.bots).toEqual([]);
    });

    it("operator token calls listAll for cross-tenant enumeration", async () => {
      fleetMock.listAll.mockResolvedValue([mockStatus]);

      const res = await app.request("/fleet/bots", { headers: authHeader });
      expect(res.status).toBe(200);
      expect(fleetMock.listAll).toHaveBeenCalled();
    });

    it("tenant-scoped token calls listByTenant and returns only that tenant's bots", async () => {
      fleetMock.listByTenant.mockResolvedValue([mockStatus]);

      const res = await app.request("/fleet/bots", {
        headers: { Authorization: `Bearer ${TENANT_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bots).toHaveLength(1);
      expect(fleetMock.listByTenant).toHaveBeenCalledWith("user-123");
      expect(fleetMock.listAll).not.toHaveBeenCalled();
    });
  });

  describe("POST /fleet/bots", () => {
    it("creates a bot with valid input", async () => {
      fleetMock.create.mockResolvedValue(mockProfile);

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          tenantId: "user-123",
          name: "test-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
          env: { TOKEN: "abc" },
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("test-bot");
    });

    it("generates a gateway service key on create and returns it in the response", async () => {
      fleetMock.create.mockResolvedValue(mockProfile);
      mockServiceKeyRepo.generate.mockResolvedValue("gw-key-xyz");

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          tenantId: "user-123",
          name: "test-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
        }),
      });

      expect(res.status).toBe(201);
      expect(mockServiceKeyRepo.generate).toHaveBeenCalledWith("user-123", TEST_BOT_ID);
      const body = await res.json();
      expect(body.gatewayKey).toBe("gw-key-xyz");
    });

    it("still returns 201 if gateway key generation fails", async () => {
      fleetMock.create.mockResolvedValue(mockProfile);
      mockServiceKeyRepo.generate.mockRejectedValue(new Error("DB down"));

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          tenantId: "user-123",
          name: "test-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.gatewayKey).toBeUndefined();
    });

    it("passes resource limits to fleet.create() based on tenant tier", async () => {
      fleetMock.create.mockResolvedValue(mockProfile);

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          tenantId: "user-123",
          name: "test-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
        }),
      });

      expect(res.status).toBe(201);
      expect(fleetMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "user-123",
          name: "test-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
        }),
        expect.objectContaining({
          Memory: expect.any(Number),
          CpuQuota: expect.any(Number),
          PidsLimit: expect.any(Number),
        }),
      );
    });

    it("rejects invalid name", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ tenantId: "user-123", name: "!!invalid!!", image: "ghcr.io/wopr-network/wopr:stable" }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects missing image", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ tenantId: "user-123", name: "valid-bot" }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects image from non-allowlisted registry", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ tenantId: "user-123", name: "good-bot", image: "evil-registry.com/cryptominer:latest" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Validation failed");
      expect(JSON.stringify(body.details)).toContain("not from an allowlisted registry");
    });

    it("rejects bare image name without registry prefix", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ tenantId: "user-123", name: "good-bot", image: "nginx:latest" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 on malformed JSON body", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "not json{{{",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 500 on fleet manager error", async () => {
      fleetMock.create.mockRejectedValue(new Error("Docker down"));

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ tenantId: "user-123", name: "bot", image: "ghcr.io/wopr-network/wopr:stable" }),
      });

      expect(res.status).toBe(500);
    });

    it("returns 201 even when billing registration rejects", async () => {
      fleetMock.create.mockResolvedValue(mockProfile);
      const registerBotMock = vi.fn().mockRejectedValueOnce(new Error("billing unavailable"));
      setFleetDeps({
        creditLedger: creditLedgerMock as never,
        botBilling: {
          registerBot: registerBotMock,
          getActiveBotCount: vi.fn().mockResolvedValue(0),
          suspendBot: vi.fn(),
          suspendAllForTenant: vi.fn().mockResolvedValue([]),
          reactivateBot: vi.fn(),
          checkReactivation: vi.fn().mockResolvedValue([]),
          destroyBot: vi.fn(),
          destroyExpiredBots: vi.fn().mockResolvedValue([]),
          getBotBilling: vi.fn().mockResolvedValue(null),
          listForTenant: vi.fn().mockResolvedValue([]),
          getStorageTier: vi.fn().mockResolvedValue(null),
          setStorageTier: vi.fn(),
          getStorageTierCostsForTenant: vi.fn().mockResolvedValue(0),
        },
        emailVerifier: { isVerified: vi.fn().mockResolvedValue(true) },
      });

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          name: "billing-fail-bot",
          tenantId: "user-123",
          image: "ghcr.io/wopr-network/wopr:stable",
        }),
      });

      expect(res.status).toBe(201);
      expect(registerBotMock).toHaveBeenCalledWith(mockProfile.id, "user-123", "billing-fail-bot");
    });

    it("returns 402 when tenant has zero credit balance", async () => {
      creditLedgerMock.balance.mockResolvedValue(Credit.fromCents(0));

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          tenantId: "user-123",
          name: "second-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
        }),
      });

      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toBe("insufficient_credits");
      expect(body.balance).toBe(0);
      expect(body.required).toBe(17);
      expect(body.buyUrl).toBe("/dashboard/credits");

      // Verify create was NOT called
      expect(fleetMock.create).not.toHaveBeenCalled();
    });

    it("returns 402 when tenant balance is below minimum (17 cents)", async () => {
      creditLedgerMock.balance.mockResolvedValue(Credit.fromCents(10));

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          tenantId: "user-123",
          name: "second-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
        }),
      });

      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toBe("insufficient_credits");
      expect(body.balance).toBe(10);
      expect(body.required).toBe(17);

      expect(fleetMock.create).not.toHaveBeenCalled();
    });

    it("allows bot creation when tenant has positive credit balance", async () => {
      creditLedgerMock.balance.mockResolvedValue(Credit.fromCents(1000));
      fleetMock.profiles.list = vi.fn().mockResolvedValue([]);
      fleetMock.create.mockResolvedValue(mockProfile);

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          tenantId: "user-123",
          name: "first-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
        }),
      });

      expect(res.status).toBe(201);
      expect(fleetMock.create).toHaveBeenCalled();
    });

    it("allows bot creation for new tenant with positive balance", async () => {
      creditLedgerMock.balance.mockResolvedValue(Credit.fromCents(500));
      fleetMock.profiles.list = vi.fn().mockResolvedValue([]);
      fleetMock.create.mockResolvedValue(mockProfile);

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          tenantId: "new-tenant",
          name: "first-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
        }),
      });

      expect(res.status).toBe(201);
    });

    it("returns 500 when nodeRepo.list() throws an unexpected error (not DATABASE_URL)", async () => {
      fleetMock.create.mockResolvedValue(mockProfile);
      const dbError = new Error("Connection refused: ECONNREFUSED");
      mockGetNodeRepo.mockImplementationOnce(
        () =>
          ({
            list: vi.fn().mockRejectedValue(dbError),
          }) as unknown as INodeRepository,
      );

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          tenantId: "user-123",
          name: "test-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
          env: { TOKEN: "abc" },
        }),
      });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /fleet/bots/:id", () => {
    it("returns bot status", async () => {
      fleetMock.status.mockResolvedValue(mockStatus);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.state).toBe("running");
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.status.mockRejectedValue(new MockBotNotFoundError(MISSING_BOT_ID));

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}`, { headers: authHeader });
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /fleet/bots/:id", () => {
    it("updates bot config", async () => {
      fleetMock.update.mockResolvedValue({ ...mockProfile, name: "updated-bot" });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ name: "updated-bot" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("updated-bot");
    });

    it("rejects empty update", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 on malformed JSON body", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "{bad json",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.update.mockRejectedValue(new MockBotNotFoundError(MISSING_BOT_ID));

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ name: "new-name" }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /fleet/bots/:id", () => {
    it("removes a bot", async () => {
      fleetMock.remove.mockResolvedValue(undefined);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, { method: "DELETE", headers: authHeader });
      expect(res.status).toBe(204);
    });

    it("revokes gateway service key after successful removal", async () => {
      fleetMock.remove.mockResolvedValue(undefined);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, { method: "DELETE", headers: authHeader });

      expect(res.status).toBe(204);
      expect(mockServiceKeyRepo.revokeByInstance).toHaveBeenCalledWith(TEST_BOT_ID);
    });

    it("still returns 204 if gateway key revocation fails", async () => {
      fleetMock.remove.mockResolvedValue(undefined);
      mockServiceKeyRepo.revokeByInstance.mockRejectedValue(new Error("DB down"));

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, { method: "DELETE", headers: authHeader });

      expect(res.status).toBe(204);
    });

    it("does not revoke key if fleet.remove() fails", async () => {
      fleetMock.remove.mockRejectedValue(new Error("container stuck"));

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, { method: "DELETE", headers: authHeader });

      expect(res.status).toBe(500);
      expect(mockServiceKeyRepo.revokeByInstance).not.toHaveBeenCalled();
    });

    it("passes removeVolumes query param", async () => {
      fleetMock.remove.mockResolvedValue(undefined);

      await app.request(`/fleet/bots/${TEST_BOT_ID}?removeVolumes=true`, { method: "DELETE", headers: authHeader });
      expect(fleetMock.remove).toHaveBeenCalledWith(TEST_BOT_ID, true);
    });

    it("retries all waiting recovery events even when some fail (sequential loop)", async () => {
      fleetMock.remove.mockResolvedValue(undefined);

      const retryWaiting = vi
        .fn()
        .mockRejectedValueOnce(new Error("event-1 failed"))
        .mockResolvedValueOnce({ recovered: [], failed: [] });

      const listEvents = vi.fn().mockResolvedValue([{ id: "evt-1" }, { id: "evt-2" }]);

      vi.mocked(getRecoveryOrchestrator).mockReturnValue({
        listEvents,
        retryWaiting,
      } as unknown as RecoveryOrchestrator);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(204);

      // Wait until both events have been retried
      await vi.waitFor(() => expect(retryWaiting).toHaveBeenCalledTimes(2));

      // Both events must have been retried despite first one failing
      expect(retryWaiting).toHaveBeenCalledTimes(2);
      expect(retryWaiting).toHaveBeenCalledWith("evt-1");
      expect(retryWaiting).toHaveBeenCalledWith("evt-2");
    });
  });

  describe("POST /fleet/bots/:id/start", () => {
    it("starts a bot", async () => {
      fleetMock.start.mockResolvedValue(undefined);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/start`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.start.mockRejectedValue(new MockBotNotFoundError(MISSING_BOT_ID));

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/start`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(404);
    });

    it("returns 402 when tenant has zero credit balance", async () => {
      creditLedgerMock.balance.mockResolvedValue(Credit.fromCents(0));

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/start`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toBe("insufficient_credits");
      expect(body.balance).toBe(0);
      expect(body.required).toBe(17);
      expect(body.buyUrl).toBe("/dashboard/credits");

      expect(fleetMock.start).not.toHaveBeenCalled();
    });

    it("returns 402 when tenant balance is below minimum (17 cents)", async () => {
      creditLedgerMock.balance.mockResolvedValue(Credit.fromCents(16));

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/start`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toBe("insufficient_credits");
      expect(body.balance).toBe(16);

      expect(fleetMock.start).not.toHaveBeenCalled();
    });

    it("allows start when tenant has sufficient credit balance", async () => {
      creditLedgerMock.balance.mockResolvedValue(Credit.fromCents(17));
      fleetMock.start.mockResolvedValue(undefined);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/start`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(fleetMock.start).toHaveBeenCalledWith(TEST_BOT_ID);
    });
  });

  describe("POST /fleet/bots/:id/stop", () => {
    it("stops a bot", async () => {
      fleetMock.stop.mockResolvedValue(undefined);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/stop`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /fleet/bots/:id/restart", () => {
    it("restarts a bot", async () => {
      fleetMock.restart.mockResolvedValue(undefined);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/restart`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /fleet/bots/:id/update", () => {
    it("triggers force update and returns result", async () => {
      updaterMock.updateBot.mockResolvedValue({
        botId: TEST_BOT_ID,
        success: true,
        previousImage: "ghcr.io/wopr-network/wopr:stable",
        newImage: "ghcr.io/wopr-network/wopr:stable",
        previousDigest: "sha256:old",
        newDigest: "sha256:new",
        rolledBack: false,
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/update`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(updaterMock.updateBot).toHaveBeenCalledWith(TEST_BOT_ID);
    });

    it("returns 404 when bot not found", async () => {
      updaterMock.updateBot.mockResolvedValue({
        botId: MISSING_BOT_ID,
        success: false,
        previousImage: "",
        newImage: "",
        previousDigest: null,
        newDigest: null,
        rolledBack: false,
        error: "Bot not found",
      });

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/update`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(404);
    });

    it("returns 500 on update failure", async () => {
      updaterMock.updateBot.mockResolvedValue({
        botId: TEST_BOT_ID,
        success: false,
        previousImage: "ghcr.io/wopr-network/wopr:stable",
        newImage: "ghcr.io/wopr-network/wopr:stable",
        previousDigest: null,
        newDigest: null,
        rolledBack: true,
        error: "Health check failed",
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/update`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(500);
    });
  });

  describe("GET /fleet/bots/:id/image-status", () => {
    it("returns image status for tracked bot", async () => {
      fleetMock.profiles.get.mockResolvedValue(mockProfile);
      pollerMock.getImageStatus.mockReturnValue({
        botId: TEST_BOT_ID,
        currentDigest: "sha256:abc",
        availableDigest: "sha256:def",
        updateAvailable: true,
        releaseChannel: "stable",
        updatePolicy: "manual",
        lastCheckedAt: "2026-01-01T00:00:00Z",
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/image-status`, { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updateAvailable).toBe(true);
      expect(body.currentDigest).toBe("sha256:abc");
      expect(body.availableDigest).toBe("sha256:def");
    });

    it("returns 404 when bot not found", async () => {
      fleetMock.profiles.get.mockResolvedValue(null);

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/image-status`, { headers: authHeader });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /fleet/bots/:id/logs", () => {
    it("returns structured JSON log entries", async () => {
      fleetMock.logs.mockResolvedValue(
        "2026-01-01T00:00:00.000Z [INFO] Bot started\n2026-01-01T00:00:01.000Z [ERROR] Connection failed",
      );

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/logs`, { headers: authHeader });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        timestamp: string;
        level: string;
        source: string;
        message: string;
      }[];
      expect(body).toHaveLength(2);
      expect(body[0]).toEqual({
        id: "log-0",
        timestamp: "2026-01-01T00:00:00.000Z",
        level: "info",
        source: "container",
        message: "Bot started",
      });
      expect(body[1]).toEqual({
        id: "log-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        level: "error",
        source: "container",
        message: "Connection failed",
      });
    });

    it("handles plain log lines without structured format", async () => {
      fleetMock.logs.mockResolvedValue("plain log line\nanother line");

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/logs`, { headers: authHeader });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; level: string; message: string }[];
      expect(body).toHaveLength(2);
      expect(body[0].level).toBe("info");
      expect(body[0].message).toBe("plain log line");
    });

    it("passes tail parameter", async () => {
      fleetMock.logs.mockResolvedValue("logs");

      await app.request(`/fleet/bots/${TEST_BOT_ID}/logs?tail=50`, { headers: authHeader });
      expect(fleetMock.logs).toHaveBeenCalledWith(TEST_BOT_ID, 50);
    });

    it("clamps tail to upper bound of 10000", async () => {
      fleetMock.logs.mockResolvedValue("logs");

      await app.request(`/fleet/bots/${TEST_BOT_ID}/logs?tail=99999`, { headers: authHeader });
      expect(fleetMock.logs).toHaveBeenCalledWith(TEST_BOT_ID, 10_000);
    });

    it("defaults negative tail to 100", async () => {
      fleetMock.logs.mockResolvedValue("logs");

      await app.request(`/fleet/bots/${TEST_BOT_ID}/logs?tail=-5`, { headers: authHeader });
      expect(fleetMock.logs).toHaveBeenCalledWith(TEST_BOT_ID, 100);
    });

    it("defaults tail=0 to 100", async () => {
      fleetMock.logs.mockResolvedValue("logs");

      await app.request(`/fleet/bots/${TEST_BOT_ID}/logs?tail=0`, { headers: authHeader });
      expect(fleetMock.logs).toHaveBeenCalledWith(TEST_BOT_ID, 100);
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.logs.mockRejectedValue(new MockBotNotFoundError(MISSING_BOT_ID));

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/logs`, { headers: authHeader });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /fleet/bots/:id/health", () => {
    it("returns health data for a running bot", async () => {
      fleetMock.status.mockResolvedValue({
        ...mockStatus,
        stats: { cpuPercent: 5.2, memoryUsageMb: 128, memoryLimitMb: 512, memoryPercent: 25.0 },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/health`, { headers: authHeader });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        state: string;
        health: string;
        uptime: string | null;
        stats: { cpuPercent: number; memoryUsageMb: number; memoryLimitMb: number; memoryPercent: number } | null;
      };
      expect(body.id).toBe(TEST_BOT_ID);
      expect(body.state).toBe("running");
      expect(body.health).toBe("healthy");
      expect(body.uptime).toBe("2026-01-01T00:00:00Z");
      expect(body.stats).toEqual({
        cpuPercent: expect.any(Number),
        memoryUsageMb: expect.any(Number),
        memoryLimitMb: expect.any(Number),
        memoryPercent: expect.any(Number),
      });
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.status.mockRejectedValue(new MockBotNotFoundError(MISSING_BOT_ID));

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/health`, { headers: authHeader });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /fleet/bots/:id/metrics", () => {
    it("returns metrics for a running bot", async () => {
      fleetMock.status.mockResolvedValue({
        ...mockStatus,
        stats: { cpuPercent: 5.2, memoryUsageMb: 128, memoryLimitMb: 512, memoryPercent: 25.0 },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/metrics`, { headers: authHeader });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        stats: { cpuPercent: number; memoryUsageMb: number; memoryLimitMb: number; memoryPercent: number } | null;
      };
      expect(body.id).toBe(TEST_BOT_ID);
      expect(body.stats).toEqual({
        cpuPercent: expect.any(Number),
        memoryUsageMb: expect.any(Number),
        memoryLimitMb: expect.any(Number),
        memoryPercent: expect.any(Number),
      });
    });

    it("returns null stats for a stopped bot", async () => {
      fleetMock.status.mockResolvedValue({ ...mockStatus, state: "stopped", stats: null });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/metrics`, { headers: authHeader });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; stats: null };
      expect(body.stats).toBeNull();
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.status.mockRejectedValue(new MockBotNotFoundError(MISSING_BOT_ID));

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/metrics`, { headers: authHeader });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /fleet/seed", () => {
    let origEnv: string | undefined;

    beforeEach(() => {
      origEnv = process.env.FLEET_TEMPLATES_DIR;
    });

    afterEach(() => {
      if (origEnv === undefined) {
        delete process.env.FLEET_TEMPLATES_DIR;
      } else {
        process.env.FLEET_TEMPLATES_DIR = origEnv;
      }
    });

    it("returns 200 with created bots when templates exist", async () => {
      process.env.FLEET_TEMPLATES_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "templates");
      const res = await app.request("/fleet/seed", { method: "POST", headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("created");
      expect(body).toHaveProperty("skipped");
      expect(Array.isArray(body.created)).toBe(true);
    });

    it("is idempotent — seeding twice does not duplicate bots", async () => {
      process.env.FLEET_TEMPLATES_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "templates");

      // First seed — fleet has no profiles yet
      fleetMock.profiles.list = vi.fn().mockResolvedValue([]);
      const res1 = await app.request("/fleet/seed", { method: "POST", headers: authHeader });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.created.length).toBeGreaterThan(0);

      // Second seed — fleet now reports the same names as existing profiles
      const fakeProfiles = body1.created.map((name: string) => ({
        id: "00000000-0000-4000-8000-000000000099",
        tenantId: "seed",
        name,
        description: "",
        image: "ghcr.io/wopr-network/wopr:stable",
        env: {},
        restartPolicy: "unless-stopped",
        releaseChannel: "stable",
        updatePolicy: "manual",
      }));
      fleetMock.profiles.list = vi.fn().mockResolvedValue(fakeProfiles);

      const res2 = await app.request("/fleet/seed", { method: "POST", headers: authHeader });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.created).toEqual([]);
      expect(body2.skipped).toEqual(expect.arrayContaining(body1.created));
    });

    it("returns 404 when templates directory is empty", async () => {
      process.env.FLEET_TEMPLATES_DIR = path.resolve(import.meta.dirname);
      const res = await app.request("/fleet/seed", { method: "POST", headers: authHeader });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });
  });

  describe("GET /fleet/bots/:id/settings", () => {
    it("returns 200 with bot settings", async () => {
      fleetMock.status.mockResolvedValue(mockStatus);
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/settings`, {
        headers: authHeader,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe(TEST_BOT_ID);
      expect(data.identity.name).toBe("test-bot");
    });

    it("returns 404 for missing bot", async () => {
      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/settings`, {
        headers: authHeader,
      });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /fleet/bots/:id/identity", () => {
    it("returns 200 with updated identity", async () => {
      fleetMock.update.mockResolvedValue({ ...mockProfile, name: "new-name" });
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/identity`, {
        method: "PUT",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "new-name", avatar: "", personality: "Be cool" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("new-name");
    });

    it("returns 400 for invalid body", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/identity`, {
        method: "PUT",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /fleet/bots/:id/capabilities/:capabilityId/activate", () => {
    it("returns 200 with success", async () => {
      fleetMock.update.mockResolvedValue(mockProfile);
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/capabilities/tts/activate`, {
        method: "POST",
        headers: authHeader,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("returns 400 for unknown capability", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/capabilities/unknown-cap/activate`, {
        method: "POST",
        headers: authHeader,
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("seedBots", () => {
  const makeTemplate = (name: string): ProfileTemplate => ({
    name,
    description: `Bot ${name}`,
    channel: { plugin: "test-channel", config: {} },
    provider: { plugin: "test-provider", config: {} },
    release: "stable",
    image: "ghcr.io/wopr-network/test:stable",
    restartPolicy: "unless-stopped",
    healthCheck: { endpoint: "/health", intervalSeconds: 30, timeoutSeconds: 5, retries: 3 },
    volumes: [],
    env: {},
  });

  it("creates all bots when none exist", () => {
    const templates = [makeTemplate("bot-a"), makeTemplate("bot-b")];
    const existing = new Set<string>();
    const result = seedBots(templates, existing);

    expect(result.created).toEqual(["bot-a", "bot-b"]);
    expect(result.skipped).toEqual([]);
  });

  it("skips bots that already exist", () => {
    const templates = [makeTemplate("bot-a"), makeTemplate("bot-b")];
    const existing = new Set(["bot-a"]);
    const result = seedBots(templates, existing);

    expect(result.created).toEqual(["bot-b"]);
    expect(result.skipped).toEqual(["bot-a"]);
  });

  it("skips all when all exist", () => {
    const templates = [makeTemplate("bot-a"), makeTemplate("bot-b")];
    const existing = new Set(["bot-a", "bot-b"]);
    const result = seedBots(templates, existing);

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(["bot-a", "bot-b"]);
  });

  it("handles empty template list", () => {
    const result = seedBots([], new Set());
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("adds created bots to existing set", () => {
    const templates = [makeTemplate("new-bot")];
    const existing = new Set<string>();
    seedBots(templates, existing);

    expect(existing.has("new-bot")).toBe(true);
  });
});

describe("GET /fleet/bots/:id/logs/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fleetMock.profiles.get = vi.fn().mockImplementation((id: string) => {
      if (id === TEST_BOT_ID) return Promise.resolve(mockProfile);
      return Promise.resolve(null);
    });
  });

  it("returns 401 without auth", async () => {
    const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/logs/stream`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for missing bot profile", async () => {
    const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/logs/stream`, {
      headers: authHeader,
    });
    expect(res.status).toBe(404);
  });

  it("returns SSE content type and streams log lines", async () => {
    const { PassThrough } = await import("node:stream");
    const mockStream = new PassThrough();
    fleetMock.logStream.mockResolvedValue(mockStream);

    const resPromise = app.request(`/fleet/bots/${TEST_BOT_ID}/logs/stream`, {
      headers: authHeader,
    });

    await new Promise((r) => setTimeout(r, 50));
    mockStream.write("2026-01-01T00:00:00.000Z [INFO] Hello world\n");
    mockStream.end();

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");

    const body = await res.text();
    expect(body).toContain("data:");
    expect(body).toContain("Hello world");
  });

  it("passes since query parameter to logStream", async () => {
    const { PassThrough } = await import("node:stream");
    const mockStream = new PassThrough();
    fleetMock.logStream.mockResolvedValue(mockStream);

    const resPromise = app.request(`/fleet/bots/${TEST_BOT_ID}/logs/stream?since=2026-01-01T00:00:00Z`, {
      headers: authHeader,
    });

    await new Promise((r) => setTimeout(r, 50));
    mockStream.end();

    await resPromise;
    expect(fleetMock.logStream).toHaveBeenCalledWith(TEST_BOT_ID, {
      since: "2026-01-01T00:00:00Z",
      tail: 100,
    });
  });

  it("sends closed event when stream ends", async () => {
    const { PassThrough } = await import("node:stream");
    const mockStream = new PassThrough();
    fleetMock.logStream.mockResolvedValue(mockStream);

    const resPromise = app.request(`/fleet/bots/${TEST_BOT_ID}/logs/stream`, {
      headers: authHeader,
    });

    await new Promise((r) => setTimeout(r, 50));
    mockStream.end();

    const res = await resPromise;
    const body = await res.text();
    expect(body).toContain('"type":"closed"');
    expect(body).toContain('"reason":"container_stopped"');
  });

  it("returns 404 when logStream throws BotNotFoundError", async () => {
    fleetMock.logStream.mockRejectedValue(new MockBotNotFoundError(TEST_BOT_ID));
    const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/logs/stream`, {
      headers: authHeader,
    });
    expect(res.status).toBe(404);
  });

  it("clamps tail parameter to 10000", async () => {
    const { PassThrough } = await import("node:stream");
    const mockStream = new PassThrough();
    fleetMock.logStream.mockResolvedValue(mockStream);

    const resPromise = app.request(`/fleet/bots/${TEST_BOT_ID}/logs/stream?tail=99999`, {
      headers: authHeader,
    });

    await new Promise((r) => setTimeout(r, 50));
    mockStream.end();

    await resPromise;
    expect(fleetMock.logStream).toHaveBeenCalledWith(TEST_BOT_ID, {
      tail: 10_000,
    });
  });

  describe("POST /fleet/bots/:id/upgrade-to-vps — payment gate (WOP-2003)", () => {
    beforeEach(() => {
      vi.stubEnv("STRIPE_VPS_PRICE_ID", "price_test_vps");
      // No active VPS subscription by default
      mockVpsRepo.getByBotId.mockResolvedValue(null);
    });

    it("returns 402 when tenant has no payment method on file", async () => {
      // tenantRepo.getByTenant resolves to null — no payment method
      mockTenantCustomerRepo.getByTenant.mockResolvedValue(null);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/upgrade-to-vps`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toMatch(/payment method/i);
    });

    it("does NOT return 402 when tenant has a payment method on file", async () => {
      // tenantRepo.getByTenant resolves to a customer record — payment method present
      mockTenantCustomerRepo.getByTenant.mockResolvedValue({
        tenant: mockProfile.tenantId,
        processor_customer_id: "cus_test_123",
      });

      // Stripe/checkout modules are not configured in test env — the handler will
      // fail after the payment gate, but the important assertion is that status is NOT 402.
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/upgrade-to-vps`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).not.toBe(402);
    });
  });
});
