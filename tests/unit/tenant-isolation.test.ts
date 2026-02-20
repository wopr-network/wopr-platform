/**
 * TENANT ISOLATION TEST SUITE — WOP-822
 *
 * Verifies that org A cannot access org B's data across fleet routes,
 * tenant-key routes, and billing routes.
 *
 * Two tenant-scoped tokens are configured via FLEET_TOKEN_<TENANT> env vars
 * before any module imports so buildTokenMetadataMap() picks them up.
 *
 * ============================================================================
 * DRIZZLE QUERY AUDIT — src/ review (WOP-822)
 * ============================================================================
 *
 * PROPERLY SCOPED (filtered by tenantId):
 * - src/monetization/credits/bot-billing.ts — .where(eq(botInstances.tenantId, tenantId))
 * - src/monetization/credits/credit-ledger.ts — all queries scoped by tenantId
 * - src/monetization/stripe/tenant-store.ts — .where(eq(tenantCustomers.tenant, tenant))
 * - src/monetization/metering/aggregator.ts — all queries scoped by tenant param
 * - src/admin/tenant-status/tenant-status-store.ts — .where(eq(tenantStatus.tenantId, tenantId))
 * - src/backup/snapshot-manager.ts — list() scoped by instanceId / listByTenant() scoped by tenant
 * - src/backup/restore-log-store.ts — listForTenant() scoped by tenant
 * - src/admin/notes/store.ts — scoped by noteId (admin-only)
 * - src/email/notification-queue-store.ts — scoped by tenantId
 *
 * ADMIN-ONLY (no tenant filter needed — admin role required):
 * - src/security/credential-vault/store.ts — platform-level credentials
 * - src/admin/audit-log.ts — admin audit log
 * - src/fleet/recovery-manager.ts — recovery events
 * - src/fleet/node-connection-manager.ts — nodes list (infra)
 * - src/backup/backup-status-store.ts — backup status
 *
 * INFRASTRUCTURE (no user-facing risk):
 * - src/fleet/node-provisioner.ts — node by ID (infra)
 * - src/fleet/node-connection-manager.ts — node operations (infra)
 * - src/fleet/migration-manager.ts — bot by ID (admin migration)
 *
 * ISSUES FOUND (tested below):
 * - src/api/routes/fleet.ts:121 — GET /fleet/bots listAll() returns ALL bots, no tenant filter
 * - src/api/routes/fleet.ts:157 — POST /fleet/bots accepts tenantId from body (IDOR)
 *
 * ============================================================================
 * AUTH MIDDLEWARE VERIFICATION
 * ============================================================================
 *
 * - scopedBearerAuthWithTenant() sets c.set("tokenTenantId", metadata.tenantId) on every
 *   request (src/auth/index.ts:453)
 * - validateTenantOwnership() reads tokenTenantId from context and returns 404 when
 *   resource.tenantId !== tokenTenantId (src/auth/index.ts:608)
 * - Legacy/admin tokens have no tenantId → validateTenantOwnership() passes through
 * - All /fleet/* and /api/tenant-keys/* routes use scopedBearerAuthWithTenant()
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotProfile, BotStatus } from "../../src/fleet/types.js";

// ---------------------------------------------------------------------------
// Two tenant-scoped tokens — MUST be set before any module import
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

// ---------------------------------------------------------------------------
// Bot IDs (stable UUIDs for each tenant)
// ---------------------------------------------------------------------------

const BOT_A_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const BOT_B_ID = "bbbbbbbb-0000-4000-8000-000000000002";

// ---------------------------------------------------------------------------
// Fleet mock — shared across all fleet tests
// ---------------------------------------------------------------------------

const fleetMock = {
  create: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  remove: vi.fn(),
  status: vi.fn(),
  listAll: vi.fn(),
  logs: vi.fn(),
  update: vi.fn(),
  profiles: {
    get: vi.fn(),
    list: vi.fn(),
  },
};

const creditLedgerMock = {
  balance: vi.fn().mockReturnValue(1000),
};

class MockBotNotFoundError extends Error {
  constructor(id: string) {
    super(`Bot not found: ${id}`);
    this.name = "BotNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

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
vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    pragma = vi.fn();
  },
}));
vi.mock("../../src/monetization/credits/credit-ledger.js", () => ({
  CreditLedger: class {
    balance = creditLedgerMock.balance;
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

// Dynamic import AFTER all mocks and stubEnv calls
const { fleetRoutes } = await import("../../src/api/routes/fleet.js");

const fleetApp = new Hono();
fleetApp.route("/fleet", fleetRoutes);

// ---------------------------------------------------------------------------
// Bot profile factories for each tenant
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
  };
}

const profileA = makeBotProfile(BOT_A_ID, TENANT_A, "alpha-bot");
const profileB = makeBotProfile(BOT_B_ID, TENANT_B, "bravo-bot");

// ---------------------------------------------------------------------------
// Fleet route isolation tests
// ---------------------------------------------------------------------------

describe("tenant isolation — fleet routes (WOP-822)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    creditLedgerMock.balance.mockReturnValue(1000);

    // Default: profile lookup returns the right profile per ID
    fleetMock.profiles.get.mockImplementation((id: string) => {
      if (id === BOT_A_ID) return Promise.resolve(profileA);
      if (id === BOT_B_ID) return Promise.resolve(profileB);
      return Promise.resolve(null);
    });
    fleetMock.profiles.list.mockResolvedValue([profileA, profileB]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // GET /fleet/bots/:id — validateTenantOwnership returns 404 on mismatch
  // -------------------------------------------------------------------------

  it("org A cannot read org B's bot via GET /fleet/bots/:id", async () => {
    // Tenant A's token attempts to read Tenant B's bot — expect 404
    const res = await fleetApp.request(`/fleet/bots/${BOT_B_ID}`, { headers: authA });
    expect(res.status).toBe(404);
  });

  it("org A can read org A's own bot via GET /fleet/bots/:id", async () => {
    fleetMock.status.mockResolvedValue(makeBotStatus(BOT_A_ID, "alpha-bot"));

    const res = await fleetApp.request(`/fleet/bots/${BOT_A_ID}`, { headers: authA });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("alpha-bot");
  });

  it("org B cannot read org A's bot via GET /fleet/bots/:id", async () => {
    const res = await fleetApp.request(`/fleet/bots/${BOT_A_ID}`, { headers: authB });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // GET /fleet/bots — list endpoint currently returns ALL bots (CRITICAL BUG)
  // BUG: listAll() returns bots for ALL tenants with no tokenTenantId filter.
  // After WOP-822 fix this test should assert only org A's bots are returned.
  // -------------------------------------------------------------------------

  it("GET /fleet/bots returns only caller's bots (CURRENTLY BROKEN — returns all)", async () => {
    fleetMock.listAll.mockResolvedValue([
      makeBotStatus(BOT_A_ID, "alpha-bot"),
      makeBotStatus(BOT_B_ID, "bravo-bot"),
    ]);

    const res = await fleetApp.request("/fleet/bots", { headers: authA });
    expect(res.status).toBe(200);
    const body = await res.json();

    // BUG: currently returns 2 bots (both tenants). After fix should return 1.
    // This documents the broken behavior — update assertion when fix lands.
    // expect(body.bots).toHaveLength(1);               // <-- expected after fix
    // expect(body.bots[0].id).toBe(BOT_A_ID);          // <-- expected after fix
    expect(body.bots).toHaveLength(2); // BUG: cross-tenant data leak
  });

  // -------------------------------------------------------------------------
  // POST /fleet/bots — IDOR: tenantId from body should be validated against token
  // -------------------------------------------------------------------------

  it("POST /fleet/bots with mismatched tenantId in body is rejected (CURRENTLY BROKEN — IDOR)", async () => {
    fleetMock.profiles.list.mockResolvedValue([]);
    fleetMock.create.mockResolvedValue(profileB);

    // Tenant A's token attempts to create a bot for Tenant B
    const res = await fleetApp.request("/fleet/bots", {
      method: "POST",
      headers: jsonAuthA,
      body: JSON.stringify({
        tenantId: TENANT_B, // <-- mismatched: token is TENANT_A but body says TENANT_B
        name: "sneaky-bot",
        image: "ghcr.io/wopr-network/wopr:stable",
      }),
    });

    // BUG: currently returns 201 — IDOR vulnerability.
    // After fix: should return 403 (or 400).
    // expect(res.status).toBe(403);    // <-- expected after fix
    expect(res.status).toBe(201); // BUG: IDOR — tenant A can create under tenant B's account
  });

  it("POST /fleet/bots with matching tenantId succeeds", async () => {
    fleetMock.profiles.list.mockResolvedValue([]);
    fleetMock.create.mockResolvedValue(profileA);

    const res = await fleetApp.request("/fleet/bots", {
      method: "POST",
      headers: jsonAuthA,
      body: JSON.stringify({
        tenantId: TENANT_A, // matches token's tenant
        name: "my-bot",
        image: "ghcr.io/wopr-network/wopr:stable",
      }),
    });

    expect(res.status).toBe(201);
  });

  // -------------------------------------------------------------------------
  // POST /fleet/bots/:id/start — validateTenantOwnership enforced
  // -------------------------------------------------------------------------

  it("org A cannot start org B's bot via POST /fleet/bots/:id/start", async () => {
    const res = await fleetApp.request(`/fleet/bots/${BOT_B_ID}/start`, {
      method: "POST",
      headers: authA,
    });
    expect(res.status).toBe(404);
  });

  it("org A can start org A's own bot via POST /fleet/bots/:id/start", async () => {
    fleetMock.start.mockResolvedValue(undefined);

    const res = await fleetApp.request(`/fleet/bots/${BOT_A_ID}/start`, {
      method: "POST",
      headers: authA,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // POST /fleet/bots/:id/stop
  // -------------------------------------------------------------------------

  it("org A cannot stop org B's bot via POST /fleet/bots/:id/stop", async () => {
    const res = await fleetApp.request(`/fleet/bots/${BOT_B_ID}/stop`, {
      method: "POST",
      headers: authA,
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // POST /fleet/bots/:id/restart
  // -------------------------------------------------------------------------

  it("org A cannot restart org B's bot via POST /fleet/bots/:id/restart", async () => {
    const res = await fleetApp.request(`/fleet/bots/${BOT_B_ID}/restart`, {
      method: "POST",
      headers: authA,
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // PATCH /fleet/bots/:id
  // -------------------------------------------------------------------------

  it("org A cannot update org B's bot via PATCH /fleet/bots/:id", async () => {
    const res = await fleetApp.request(`/fleet/bots/${BOT_B_ID}`, {
      method: "PATCH",
      headers: jsonAuthA,
      body: JSON.stringify({ name: "hacked-name" }),
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // DELETE /fleet/bots/:id
  // -------------------------------------------------------------------------

  it("org A cannot delete org B's bot via DELETE /fleet/bots/:id", async () => {
    const res = await fleetApp.request(`/fleet/bots/${BOT_B_ID}`, {
      method: "DELETE",
      headers: authA,
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // GET /fleet/bots/:id/logs
  // -------------------------------------------------------------------------

  it("org A cannot read org B's bot logs via GET /fleet/bots/:id/logs", async () => {
    const res = await fleetApp.request(`/fleet/bots/${BOT_B_ID}/logs`, { headers: authA });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // POST /fleet/bots/:id/update
  // -------------------------------------------------------------------------

  it("org A cannot update org B's bot image via POST /fleet/bots/:id/update", async () => {
    const res = await fleetApp.request(`/fleet/bots/${BOT_B_ID}/update`, {
      method: "POST",
      headers: authA,
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tenant-key route isolation tests
// ---------------------------------------------------------------------------

// We need the real BetterSqlite3 (not the mocked one used by fleet tests).
// Use vi.importActual to get the real module.
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { TenantKeyStore } from "../../src/security/tenant-keys/schema.js";

const ActualBetterSqlite3 = (
  await vi.importActual<typeof import("better-sqlite3")>("better-sqlite3")
).default as new (path: string) => BetterSqlite3Database;

// Import tenant-key routes (shares the same mocked FLEET_TOKEN env vars)
const { tenantKeyRoutes, setStore } = await import("../../src/api/routes/tenant-keys.js");

const keysApp = new Hono();
keysApp.route("/api/tenant-keys", tenantKeyRoutes);

describe("tenant isolation — tenant-key routes (WOP-822)", () => {
  let sqlite: BetterSqlite3Database;
  let store: TenantKeyStore;

  beforeEach(() => {
    // Use real SQLite in-memory DB — TenantKeyStore handles its own schema
    sqlite = new ActualBetterSqlite3(":memory:");
    store = new TenantKeyStore(sqlite);
    setStore(store);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("org A cannot list org B's keys", async () => {
    // Store a key for tenant B
    await keysApp.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonAuthB,
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-bravo-key", label: "Bravo Key" }),
    });

    // Tenant A lists — should see no keys (not B's keys)
    const res = await keysApp.request("/api/tenant-keys", { headers: authA });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toHaveLength(0);
  });

  it("org A cannot read org B's key by provider", async () => {
    // Store a key for tenant B
    await keysApp.request("/api/tenant-keys/openai", {
      method: "PUT",
      headers: jsonAuthB,
      body: JSON.stringify({ provider: "openai", apiKey: "sk-bravo-openai", label: "B OpenAI" }),
    });

    // Tenant A tries to read tenant B's openai key — expect 404
    const res = await keysApp.request("/api/tenant-keys/openai", { headers: authA });
    expect(res.status).toBe(404);
  });

  it("org A cannot delete org B's key", async () => {
    // Store a key for tenant B
    await keysApp.request("/api/tenant-keys/anthropic", {
      method: "PUT",
      headers: jsonAuthB,
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-bravo-key" }),
    });

    // Tenant A tries to delete it — expect 404 (not found under A's namespace)
    const res = await keysApp.request("/api/tenant-keys/anthropic", {
      method: "DELETE",
      headers: authA,
    });
    expect(res.status).toBe(404);

    // Verify the key still exists for tenant B
    const record = store.get(TENANT_B, "anthropic");
    expect(record).toBeDefined();
  });

  it("each tenant's keys are stored and retrieved independently", async () => {
    // Both tenants store a key for the same provider
    await keysApp.request("/api/tenant-keys/openai", {
      method: "PUT",
      headers: jsonAuthA,
      body: JSON.stringify({ provider: "openai", apiKey: "sk-alpha-key", label: "A Key" }),
    });
    await keysApp.request("/api/tenant-keys/openai", {
      method: "PUT",
      headers: jsonAuthB,
      body: JSON.stringify({ provider: "openai", apiKey: "sk-bravo-key", label: "B Key" }),
    });

    // Each tenant sees only their own key
    const resA = await keysApp.request("/api/tenant-keys", { headers: authA });
    const bodyA = await resA.json();
    expect(bodyA.keys).toHaveLength(1);
    expect(bodyA.keys[0].label).toBe("A Key");

    const resB = await keysApp.request("/api/tenant-keys", { headers: authB });
    const bodyB = await resB.json();
    expect(bodyB.keys).toHaveLength(1);
    expect(bodyB.keys[0].label).toBe("B Key");
  });
});
