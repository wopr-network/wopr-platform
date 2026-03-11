/**
 * E2E: Tenant isolation — cross-tenant data access blocked at API layer (WOP-1685).
 *
 * Mounts real Hono route handlers with real scopedBearerAuthWithTenant middleware
 * against a PGlite test DB. Creates two tenants with separate bearer tokens via
 * FLEET_TOKEN_<TENANT> env vars. Seeds resources for Tenant A, then verifies
 * Tenant B gets 404/403 for every cross-tenant request.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import {
  beginTestTransaction,
  createTestDb,
  endTestTransaction,
  rollbackTestTransaction,
} from "../../src/test/db.js";
import { TenantKeyRepository } from "@wopr-network/platform-core";
import { Hono } from "hono";
import type { BotProfile, BotStatus } from "../../src/fleet/types.js";

// ---------------------------------------------------------------------------
// Two tenants — env vars MUST be set before any route module imports
// ---------------------------------------------------------------------------

const TENANT_A = "tenant-alpha";
const TENANT_B = "tenant-bravo";
const TOKEN_A = "wopr_write_alphatoken00000001";
const TOKEN_B = "wopr_write_bravotoken00000001";

vi.stubEnv(`FLEET_TOKEN_${TENANT_A}`, `write:${TOKEN_A}`);
vi.stubEnv(`FLEET_TOKEN_${TENANT_B}`, `write:${TOKEN_B}`);
vi.stubEnv("PLATFORM_SECRET", "test-platform-secret-32bytes!!ok");

const authA = { Authorization: `Bearer ${TOKEN_A}` };
const authB = { Authorization: `Bearer ${TOKEN_B}` };
const jsonAuthA = { "Content-Type": "application/json", ...authA };
const jsonAuthB = { "Content-Type": "application/json", ...authB };

const BOT_A_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const BOT_B_ID = "bbbbbbbb-0000-4000-8000-000000000002";

// ---------------------------------------------------------------------------
// Fleet mocks (same pattern as unit tests)
// ---------------------------------------------------------------------------

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
  update: vi.fn(),
  profiles: {
    get: vi.fn(),
    list: vi.fn(),
  },
};

class MockBotNotFoundError extends Error {
  constructor(id: string) {
    super(`Bot not found: ${id}`);
    this.name = "BotNotFoundError";
  }
}

vi.mock("dockerode", () => ({ default: class MockDocker {} }));
vi.mock("../../src/fleet/profile-store.js", () => ({
  ProfileStore: class MockProfileStore {},
}));
vi.mock("../../src/fleet/fleet-manager.js", () => ({
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
    update = fleetMock.update;
    profiles = fleetMock.profiles;
  },
  BotNotFoundError: MockBotNotFoundError,
}));
vi.mock("../../src/fleet/image-poller.js", () => ({
  ImagePoller: class {
    getImageStatus = vi.fn();
    onUpdateAvailable = null;
  },
}));
vi.mock("../../src/fleet/updater.js", () => ({
  ContainerUpdater: class {
    updateBot = vi.fn();
  },
}));
vi.mock("../../src/network/network-policy.js", () => ({
  NetworkPolicy: class {
    prepareForContainer = vi.fn().mockResolvedValue("wopr-tenant-mock");
    cleanupAfterRemoval = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock("../../src/monetization/credits/credit-ledger.js", () => ({
  CreditLedger: class {
    balance = vi.fn().mockReturnValue(1000);
  },
}));
vi.mock("../../src/proxy/singleton.js", () => ({
  getProxyManager: () => ({
    addRoute: vi.fn().mockResolvedValue(undefined),
    removeRoute: vi.fn(),
    updateHealth: vi.fn(),
  }),
  hydrateProxyRoutes: vi.fn().mockResolvedValue(undefined),
}));

// Dynamic imports AFTER mocks
const { fleetRoutes, setFleetDeps } = await import("../../src/api/routes/fleet.js");
const { tenantKeyRoutes, setRepo } = await import("../../src/api/routes/tenant-keys.js");

setFleetDeps({
  creditLedger: { balance: vi.fn().mockReturnValue(10000) } as never,
  botBilling: { registerBot: vi.fn(), getActiveBotCount: vi.fn().mockReturnValue(0) } as never,
  emailVerifier: { isVerified: vi.fn().mockReturnValue(true) },
});

// Mount routes on Hono apps
const fleetApp = new Hono();
fleetApp.route("/fleet", fleetRoutes);

const keysApp = new Hono();
keysApp.route("/api/tenant-keys", tenantKeyRoutes);

// ---------------------------------------------------------------------------
// Bot profile factories
// ---------------------------------------------------------------------------

function makeBotProfile(id: string, tenantId: string, name: string): BotProfile {
  return {
    id,
    tenantId,
    name,
    description: `Bot for ${tenantId}`,
    image: "ghcr.io/wopr-network/wopr:stable",
    env: {},
    restartPolicy: "unless-stopped",
    releaseChannel: "stable",
    updatePolicy: "manual",
  };
}

function makeBotStatus(id: string, name: string): BotStatus {
  return {
    id,
    name,
    description: "",
    image: "ghcr.io/wopr-network/wopr:stable",
    containerId: "container-xyz",
    state: "running",
    health: "healthy",
    uptime: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    stats: null,
    applicationMetrics: null,
  };
}

const profileA = makeBotProfile(BOT_A_ID, TENANT_A, "alpha-bot");
const profileB = makeBotProfile(BOT_B_ID, TENANT_B, "bravo-bot");

// ---------------------------------------------------------------------------
// E2E: Tenant isolation — cross-tenant data access blocked at API layer
// ---------------------------------------------------------------------------

describe("E2E: tenant isolation — cross-tenant data access blocked at API layer", () => {
  describe("bot routes", () => {
    beforeEach(() => {
      vi.clearAllMocks();

      fleetMock.profiles.get.mockImplementation((id: string) => {
        if (id === BOT_A_ID) return Promise.resolve(profileA);
        if (id === BOT_B_ID) return Promise.resolve(profileB);
        return Promise.resolve(null);
      });
      fleetMock.profiles.list.mockResolvedValue([profileA, profileB]);
      fleetMock.listByTenant.mockImplementation(async (tenantId: string) => {
        if (tenantId === TENANT_A) return [makeBotStatus(BOT_A_ID, "alpha-bot")];
        if (tenantId === TENANT_B) return [makeBotStatus(BOT_B_ID, "bravo-bot")];
        return [];
      });
    });

    it("Tenant A can create a bot", async () => {
      fleetMock.profiles.list.mockResolvedValue([]);
      fleetMock.create.mockResolvedValue(profileA);

      const res = await fleetApp.request("/fleet/bots", {
        method: "POST",
        headers: jsonAuthA,
        body: JSON.stringify({
          tenantId: TENANT_A,
          name: "alpha-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
        }),
      });
      expect(res.status).toBe(201);
    });

    it("Tenant B cannot GET Tenant A's bot", async () => {
      const res = await fleetApp.request(`/fleet/bots/${BOT_A_ID}`, { headers: authB });
      expect([403, 404]).toContain(res.status);
    });

    it("Tenant B cannot PATCH Tenant A's bot", async () => {
      const res = await fleetApp.request(`/fleet/bots/${BOT_A_ID}`, {
        method: "PATCH",
        headers: jsonAuthB,
        body: JSON.stringify({ name: "hacked" }),
      });
      expect([403, 404]).toContain(res.status);
    });

    it("Tenant B cannot DELETE Tenant A's bot", async () => {
      const res = await fleetApp.request(`/fleet/bots/${BOT_A_ID}`, {
        method: "DELETE",
        headers: authB,
      });
      expect([403, 404]).toContain(res.status);
    });

    it("Tenant B can still access own bot", async () => {
      fleetMock.status.mockResolvedValue(makeBotStatus(BOT_B_ID, "bravo-bot"));

      const res = await fleetApp.request(`/fleet/bots/${BOT_B_ID}`, { headers: authB });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("bravo-bot");
    });

    it("Tenant B cannot start Tenant A's bot", async () => {
      const res = await fleetApp.request(`/fleet/bots/${BOT_A_ID}/start`, {
        method: "POST",
        headers: authB,
      });
      expect([403, 404]).toContain(res.status);
    });

    it("Tenant B cannot stop Tenant A's bot", async () => {
      const res = await fleetApp.request(`/fleet/bots/${BOT_A_ID}/stop`, {
        method: "POST",
        headers: authB,
      });
      expect([403, 404]).toContain(res.status);
    });

    it("auth checks complete in <5s", async () => {
      const start = Date.now();
      await fleetApp.request(`/fleet/bots/${BOT_A_ID}`, { headers: authB });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe("tenant-key (credential) routes", () => {
    let pool: PGlite;
    let db: DrizzleDb;
    let store: TenantKeyRepository;

    beforeAll(async () => {
      ({ db, pool } = await createTestDb());
      await beginTestTransaction(pool);
      store = new TenantKeyRepository(db);
      setRepo(store);
    });

    afterAll(async () => {
      await endTestTransaction(pool);
      await pool.close();
    });

    beforeEach(async () => {
      await rollbackTestTransaction(pool);
    });

    it("Tenant A can store a tenant key", async () => {
      const res = await keysApp.request("/api/tenant-keys/anthropic", {
        method: "PUT",
        headers: jsonAuthA,
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-alpha-key", label: "Alpha Key" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("Tenant B cannot GET Tenant A's tenant key", async () => {
      await keysApp.request("/api/tenant-keys/anthropic", {
        method: "PUT",
        headers: jsonAuthA,
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-alpha-key", label: "Alpha Key" }),
      });

      const res = await keysApp.request("/api/tenant-keys/anthropic", { headers: authB });
      expect(res.status).toBe(404);
    });

    it("Tenant B cannot list Tenant A's keys", async () => {
      await keysApp.request("/api/tenant-keys/openai", {
        method: "PUT",
        headers: jsonAuthA,
        body: JSON.stringify({ provider: "openai", apiKey: "sk-alpha-openai", label: "A OpenAI" }),
      });

      const res = await keysApp.request("/api/tenant-keys", { headers: authB });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys).toHaveLength(0);
    });

    it("Tenant B cannot DELETE Tenant A's tenant key", async () => {
      await keysApp.request("/api/tenant-keys/anthropic", {
        method: "PUT",
        headers: jsonAuthA,
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-alpha-key" }),
      });

      const res = await keysApp.request("/api/tenant-keys/anthropic", {
        method: "DELETE",
        headers: authB,
      });
      expect(res.status).toBe(404);

      const record = await store.get(TENANT_A, "anthropic");
      expect(record).not.toBeNull();
    });

    it("Tenant B can still access own keys", async () => {
      await keysApp.request("/api/tenant-keys/openai", {
        method: "PUT",
        headers: jsonAuthA,
        body: JSON.stringify({ provider: "openai", apiKey: "sk-alpha", label: "A" }),
      });
      await keysApp.request("/api/tenant-keys/openai", {
        method: "PUT",
        headers: jsonAuthB,
        body: JSON.stringify({ provider: "openai", apiKey: "sk-bravo", label: "B" }),
      });

      const resA = await keysApp.request("/api/tenant-keys", { headers: authA });
      const bodyA = await resA.json();
      expect(bodyA.keys).toHaveLength(1);
      expect(bodyA.keys[0].label).toBe("A");

      const resB = await keysApp.request("/api/tenant-keys", { headers: authB });
      const bodyB = await resB.json();
      expect(bodyB.keys).toHaveLength(1);
      expect(bodyB.keys[0].label).toBe("B");
    });
  });
});
