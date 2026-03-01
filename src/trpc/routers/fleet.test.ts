/**
 * Unit tests for the tRPC fleet router.
 *
 * Uses the caller pattern — no HTTP transport needed, tests run against
 * the router directly via appRouter.createCaller(ctx).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleStore } from "../../admin/roles/role-store.js";
import type { IBotInstanceRepository } from "../../fleet/bot-instance-repository.js";
import type { FleetManager } from "../../fleet/fleet-manager.js";
import { BotNotFoundError } from "../../fleet/fleet-manager.js";
import type { ProfileTemplate } from "../../fleet/profile-schema.js";
import type { BotInstance } from "../../fleet/repository-types.js";
import { Credit } from "../../monetization/credit.js";
import { appRouter } from "../index.js";
import type { TRPCContext } from "../init.js";
import { setTrpcOrgMemberRepo } from "../init.js";
import { setFleetRouterDeps } from "./fleet.js";

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function authedContext(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return { user: { id: "test-user", roles: ["admin"] }, tenantId: "test-tenant", ...overrides };
}

function unauthContext(): TRPCContext {
  return { user: undefined, tenantId: undefined };
}

/** Create a tRPC caller with the given context. */
function createCaller(ctx: TRPCContext) {
  return appRouter.createCaller(ctx);
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const TEST_BOT_ID = "00000000-0000-4000-8000-000000000001";

/** Dynamic timestamp so tests never go stale. */
const TEST_TIMESTAMP = new Date().toISOString();

const mockProfile = {
  id: TEST_BOT_ID,
  tenantId: "test-tenant",
  name: "test-bot",
  description: "A test bot",
  image: "ghcr.io/wopr-network/wopr:stable",
  env: {},
  restartPolicy: "unless-stopped" as const,
  releaseChannel: "stable" as const,
  updatePolicy: "manual" as const,
};

const mockStatus = {
  id: TEST_BOT_ID,
  name: "test-bot",
  description: "A test bot",
  image: "ghcr.io/wopr-network/wopr:stable",
  containerId: "container-123",
  state: "running" as const,
  health: "healthy",
  uptime: TEST_TIMESTAMP,
  startedAt: TEST_TIMESTAMP,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP,
  stats: { cpuPercent: 5.2, memoryUsageMb: 128, memoryLimitMb: 512, memoryPercent: 25.0 },
};

const mockBotInstance: BotInstance = {
  id: TEST_BOT_ID,
  tenantId: "test-tenant",
  name: "test-bot",
  nodeId: null,
  billingState: "active",
  suspendedAt: null,
  destroyAfter: null,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP,
  createdByUserId: "test-user",
};

const mockTemplates: ProfileTemplate[] = [
  {
    name: "default",
    description: "Default bot template",
    channel: { plugin: "discord", config: {} },
    provider: { plugin: "openrouter", config: {} },
    release: "stable",
    image: "ghcr.io/wopr-network/wopr:stable",
    restartPolicy: "unless-stopped",
    healthCheck: { endpoint: "/health", intervalSeconds: 30, timeoutSeconds: 5, retries: 3 },
    volumes: [],
    env: {},
  },
];

// ---------------------------------------------------------------------------
// Fleet mock
// ---------------------------------------------------------------------------

function createFleetMock() {
  return {
    listByTenant: vi.fn().mockResolvedValue([mockStatus]),
    status: vi.fn().mockResolvedValue(mockStatus),
    create: vi.fn().mockResolvedValue(mockProfile),
    update: vi.fn().mockResolvedValue(mockProfile),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    logs: vi.fn().mockResolvedValue(`${TEST_TIMESTAMP} log line 1\n`),
    getVolumeUsage: vi.fn().mockResolvedValue(null),
    profiles: {
      get: vi.fn().mockResolvedValue(mockProfile),
      list: vi.fn().mockResolvedValue([mockProfile]),
    },
  };
}

let fleetMock: ReturnType<typeof createFleetMock>;

const mockRoleStore: RoleStore = {
  getRole: vi.fn().mockReturnValue("tenant_admin"),
} as unknown as RoleStore;

const mockBotInstanceRepo: IBotInstanceRepository = {
  getById: vi.fn().mockReturnValue(mockBotInstance),
  listByNode: vi.fn().mockReturnValue([]),
  listByTenant: vi.fn().mockReturnValue([]),
  upsert: vi.fn(),
  updateBillingState: vi.fn(),
  delete: vi.fn(),
} as unknown as IBotInstanceRepository;

beforeAll(() => {
  setTrpcOrgMemberRepo({
    findMember: async () => ({
      id: "m1",
      orgId: "test-tenant",
      userId: "test-user",
      role: "owner" as const,
      joinedAt: Date.now(),
    }),
    listMembers: async () => [],
    addMember: async () => {},
    updateMemberRole: async () => {},
    removeMember: async () => {},
    countAdminsAndOwners: async () => 1,
    listInvites: async () => [],
    createInvite: async () => {},
    findInviteById: async () => null,
    findInviteByToken: async () => null,
    deleteInvite: async () => {},
    deleteAllMembers: async () => {},
    deleteAllInvites: async () => {},
  });
});

beforeEach(() => {
  fleetMock = createFleetMock();
  setFleetRouterDeps({
    getFleetManager: () => fleetMock as unknown as FleetManager,
    getTemplates: () => mockTemplates,
    getCreditLedger: () => null,
    getBotBilling: () => null,
    getBotInstanceRepo: () => mockBotInstanceRepo,
    getRoleStore: () => mockRoleStore,
  });
});

// ---------------------------------------------------------------------------
// listInstances
// ---------------------------------------------------------------------------

describe("fleet.listInstances", () => {
  it("returns bots for tenant", async () => {
    const caller = createCaller(authedContext());
    const result = await caller.fleet.listInstances();
    expect(result.bots).toEqual([mockStatus]);
    expect(fleetMock.listByTenant).toHaveBeenCalledWith("test-tenant");
  });

  it("rejects unauthenticated", async () => {
    const caller = createCaller(unauthContext());
    await expect(caller.fleet.listInstances()).rejects.toThrow("Authentication required");
  });

  it("rejects missing tenant context", async () => {
    const caller = createCaller({ user: { id: "u1", roles: ["admin"] }, tenantId: undefined });
    await expect(caller.fleet.listInstances()).rejects.toThrow("Tenant context required");
  });
});

// ---------------------------------------------------------------------------
// getInstance
// ---------------------------------------------------------------------------

describe("fleet.getInstance", () => {
  it("returns bot status when profile tenantId matches ctx.tenantId", async () => {
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getInstance({ id: TEST_BOT_ID });
    expect(result).toEqual(mockStatus);
    expect(fleetMock.profiles.get).toHaveBeenCalledWith(TEST_BOT_ID);
    expect(fleetMock.status).toHaveBeenCalledWith(TEST_BOT_ID);
  });

  it("throws NOT_FOUND when profile tenantId does not match ctx.tenantId", async () => {
    fleetMock.profiles.get.mockResolvedValue({ ...mockProfile, tenantId: "other-tenant" });
    const caller = createCaller(authedContext());
    await expect(caller.fleet.getInstance({ id: TEST_BOT_ID })).rejects.toMatchObject({
      message: "Bot not found",
    });
  });

  it("throws NOT_FOUND when bot does not exist (profiles.get returns null)", async () => {
    fleetMock.profiles.get.mockResolvedValue(null);
    const caller = createCaller(authedContext());
    await expect(caller.fleet.getInstance({ id: TEST_BOT_ID })).rejects.toMatchObject({
      message: "Bot not found",
    });
  });

  it("maps BotNotFoundError to NOT_FOUND", async () => {
    fleetMock.status.mockRejectedValue(new BotNotFoundError(TEST_BOT_ID));
    const caller = createCaller(authedContext());
    await expect(caller.fleet.getInstance({ id: TEST_BOT_ID })).rejects.toMatchObject({
      message: expect.stringContaining(TEST_BOT_ID),
    });
  });
});

// ---------------------------------------------------------------------------
// createInstance
// ---------------------------------------------------------------------------

describe("fleet.createInstance", () => {
  const createInput = {
    name: "new-bot",
    image: "ghcr.io/wopr-network/wopr:stable",
  };

  it("calls fleet.create with ctx.tenantId injected; returns profile", async () => {
    const caller = createCaller(authedContext());
    const result = await caller.fleet.createInstance(createInput);
    expect(result).toEqual(mockProfile);
    expect(fleetMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "new-bot", tenantId: "test-tenant" }),
    );
  });

  it("rejects unauthenticated", async () => {
    const caller = createCaller(unauthContext());
    await expect(caller.fleet.createInstance(createInput)).rejects.toThrow("Authentication required");
  });
});

// ---------------------------------------------------------------------------
// controlInstance
// ---------------------------------------------------------------------------

describe("fleet.controlInstance", () => {
  it("calls fleet.start after verifying ownership", async () => {
    const caller = createCaller(authedContext());
    const result = await caller.fleet.controlInstance({ id: TEST_BOT_ID, action: "start" });
    expect(result).toEqual({ ok: true });
    expect(fleetMock.start).toHaveBeenCalledWith(TEST_BOT_ID);
  });

  it("calls fleet.stop after verifying ownership", async () => {
    const caller = createCaller(authedContext());
    const result = await caller.fleet.controlInstance({ id: TEST_BOT_ID, action: "stop" });
    expect(result).toEqual({ ok: true });
    expect(fleetMock.stop).toHaveBeenCalledWith(TEST_BOT_ID);
  });

  it("calls fleet.restart after verifying ownership", async () => {
    const caller = createCaller(authedContext());
    const result = await caller.fleet.controlInstance({ id: TEST_BOT_ID, action: "restart" });
    expect(result).toEqual({ ok: true });
    expect(fleetMock.restart).toHaveBeenCalledWith(TEST_BOT_ID);
  });

  it("throws NOT_FOUND for non-owned bot", async () => {
    fleetMock.profiles.get.mockResolvedValue({ ...mockProfile, tenantId: "other-tenant" });
    const caller = createCaller(authedContext());
    await expect(caller.fleet.controlInstance({ id: TEST_BOT_ID, action: "start" })).rejects.toMatchObject({
      message: "Bot not found",
    });
  });

  it("calls fleet.remove after verifying ownership (destroy)", async () => {
    const caller = createCaller(authedContext());
    const result = await caller.fleet.controlInstance({ id: TEST_BOT_ID, action: "destroy" });
    expect(result).toEqual({ ok: true });
    expect(fleetMock.remove).toHaveBeenCalledWith(TEST_BOT_ID);
  });
});

// ---------------------------------------------------------------------------
// getInstanceHealth
// ---------------------------------------------------------------------------

describe("fleet.getInstanceHealth", () => {
  it("returns health/stats subset of status", async () => {
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getInstanceHealth({ id: TEST_BOT_ID });
    expect(result).toEqual({
      id: mockStatus.id,
      state: mockStatus.state,
      health: mockStatus.health,
      uptime: mockStatus.uptime,
      stats: mockStatus.stats,
    });
  });

  it("throws NOT_FOUND for missing bot", async () => {
    fleetMock.profiles.get.mockResolvedValue(null);
    const caller = createCaller(authedContext());
    await expect(caller.fleet.getInstanceHealth({ id: TEST_BOT_ID })).rejects.toMatchObject({
      message: "Bot not found",
    });
  });
});

// ---------------------------------------------------------------------------
// getInstanceLogs
// ---------------------------------------------------------------------------

describe("fleet.getInstanceLogs", () => {
  it("returns logs split into string array; default tail=100", async () => {
    fleetMock.logs.mockResolvedValue(`${TEST_TIMESTAMP} log line 1\n${TEST_TIMESTAMP} log line 2`);
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getInstanceLogs({ id: TEST_BOT_ID });
    expect(result).toEqual({
      logs: [`${TEST_TIMESTAMP} log line 1`, `${TEST_TIMESTAMP} log line 2`],
    });
    expect(fleetMock.logs).toHaveBeenCalledWith(TEST_BOT_ID, 100);
  });

  it("filters out empty lines from split", async () => {
    fleetMock.logs.mockResolvedValue("line1\n\nline2\n");
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getInstanceLogs({ id: TEST_BOT_ID });
    expect(result).toEqual({ logs: ["line1", "line2"] });
  });

  it("returns empty array when logs are empty string", async () => {
    fleetMock.logs.mockResolvedValue("");
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getInstanceLogs({ id: TEST_BOT_ID });
    expect(result).toEqual({ logs: [] });
  });

  it("respects custom tail parameter", async () => {
    fleetMock.logs.mockResolvedValue("line");
    const caller = createCaller(authedContext());
    await caller.fleet.getInstanceLogs({ id: TEST_BOT_ID, tail: 50 });
    expect(fleetMock.logs).toHaveBeenCalledWith(TEST_BOT_ID, 50);
  });

  it("throws NOT_FOUND for non-owned bot", async () => {
    fleetMock.profiles.get.mockResolvedValue({ ...mockProfile, tenantId: "other-tenant" });
    const caller = createCaller(authedContext());
    await expect(caller.fleet.getInstanceLogs({ id: TEST_BOT_ID })).rejects.toMatchObject({
      message: "Bot not found",
    });
  });
});

// ---------------------------------------------------------------------------
// getInstanceMetrics
// ---------------------------------------------------------------------------

describe("fleet.getInstanceMetrics", () => {
  it("returns stats from status", async () => {
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getInstanceMetrics({ id: TEST_BOT_ID });
    expect(result).toEqual({
      id: mockStatus.id,
      stats: mockStatus.stats,
    });
  });

  it("throws NOT_FOUND for non-owned bot", async () => {
    fleetMock.profiles.get.mockResolvedValue(null);
    const caller = createCaller(authedContext());
    await expect(caller.fleet.getInstanceMetrics({ id: TEST_BOT_ID })).rejects.toMatchObject({
      message: "Bot not found",
    });
  });
});

// ---------------------------------------------------------------------------
// listTemplates
// ---------------------------------------------------------------------------

describe("fleet.listTemplates", () => {
  it("returns templates array", async () => {
    const caller = createCaller(authedContext());
    const result = await caller.fleet.listTemplates();
    expect(result).toEqual({ templates: mockTemplates });
  });

  it("rejects unauthenticated", async () => {
    const caller = createCaller(unauthContext());
    await expect(caller.fleet.listTemplates()).rejects.toThrow("Authentication required");
  });
});

// ---------------------------------------------------------------------------
// getSettings
// ---------------------------------------------------------------------------

describe("fleet.getSettings", () => {
  it("returns composed bot settings for owned bot", async () => {
    fleetMock.profiles.get.mockResolvedValue({
      ...mockProfile,
      env: { WOPR_PLUGINS: "discord", WOPR_PLUGINS_DISABLED: "" },
    });
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getSettings({ id: TEST_BOT_ID });
    expect(result.id).toBe(TEST_BOT_ID);
    expect(result.identity.name).toBe("test-bot");
    expect(result.status).toBe("running");
    expect(result.installedPlugins).toEqual([
      {
        id: "discord",
        name: "discord",
        description: "",
        icon: "",
        status: "active",
        capabilities: [],
      },
    ]);
  });

  it("returns stopped status when bot state is stopped", async () => {
    fleetMock.status.mockResolvedValue({ ...mockStatus, state: "stopped" });
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getSettings({ id: TEST_BOT_ID });
    expect(result.status).toBe("stopped");
  });

  it("throws NOT_FOUND for non-owned bot", async () => {
    fleetMock.profiles.get.mockResolvedValue({ ...mockProfile, tenantId: "other-tenant" });
    const caller = createCaller(authedContext());
    await expect(caller.fleet.getSettings({ id: TEST_BOT_ID })).rejects.toMatchObject({
      message: "Bot not found",
    });
  });

  it("throws NOT_FOUND when bot does not exist", async () => {
    fleetMock.profiles.get.mockResolvedValue(null);
    const caller = createCaller(authedContext());
    await expect(caller.fleet.getSettings({ id: TEST_BOT_ID })).rejects.toMatchObject({
      message: "Bot not found",
    });
  });

  it("rejects unauthenticated", async () => {
    const caller = createCaller(unauthContext());
    await expect(caller.fleet.getSettings({ id: TEST_BOT_ID })).rejects.toThrow("Authentication required");
  });
});

// ---------------------------------------------------------------------------
// updateIdentity
// ---------------------------------------------------------------------------

describe("fleet.updateIdentity", () => {
  it("updates bot name and description via fleet.update", async () => {
    const updatedProfile = { ...mockProfile, name: "new-name", description: "new desc" };
    fleetMock.update.mockResolvedValue(updatedProfile);
    const caller = createCaller(authedContext());
    const result = await caller.fleet.updateIdentity({
      id: TEST_BOT_ID,
      name: "new-name",
      avatar: "",
      personality: "Be helpful",
    });
    expect(result.name).toBe("new-name");
    expect(result.avatar).toBe("");
    expect(fleetMock.update).toHaveBeenCalledWith(TEST_BOT_ID, expect.objectContaining({ name: "new-name" }));
  });

  it("throws NOT_FOUND for non-owned bot", async () => {
    fleetMock.profiles.get.mockResolvedValue({ ...mockProfile, tenantId: "other-tenant" });
    const caller = createCaller(authedContext());
    await expect(
      caller.fleet.updateIdentity({ id: TEST_BOT_ID, name: "x", avatar: "", personality: "" }),
    ).rejects.toMatchObject({ message: "Bot not found" });
  });

  it("throws NOT_FOUND when bot does not exist", async () => {
    fleetMock.profiles.get.mockResolvedValue(null);
    const caller = createCaller(authedContext());
    await expect(
      caller.fleet.updateIdentity({ id: TEST_BOT_ID, name: "x", avatar: "", personality: "" }),
    ).rejects.toMatchObject({ message: "Bot not found" });
  });

  it("rejects unauthenticated", async () => {
    const caller = createCaller(unauthContext());
    await expect(
      caller.fleet.updateIdentity({ id: TEST_BOT_ID, name: "x", avatar: "", personality: "" }),
    ).rejects.toThrow("Authentication required");
  });
});

// ---------------------------------------------------------------------------
// activateCapability
// ---------------------------------------------------------------------------

describe("fleet.activateCapability", () => {
  it("returns success when capability is known", async () => {
    fleetMock.update.mockResolvedValue(mockProfile);
    const caller = createCaller(authedContext());
    const result = await caller.fleet.activateCapability({
      id: TEST_BOT_ID,
      capabilityId: "tts",
    });
    expect(result.success).toBe(true);
    expect(result.capabilityId).toBe("tts");
  });

  it("throws BAD_REQUEST for unknown capability", async () => {
    const caller = createCaller(authedContext());
    await expect(
      caller.fleet.activateCapability({ id: TEST_BOT_ID, capabilityId: "unknown-cap" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("throws NOT_FOUND for non-owned bot", async () => {
    fleetMock.profiles.get.mockResolvedValue({ ...mockProfile, tenantId: "other-tenant" });
    const caller = createCaller(authedContext());
    await expect(caller.fleet.activateCapability({ id: TEST_BOT_ID, capabilityId: "tts" })).rejects.toMatchObject({
      message: "Bot not found",
    });
  });

  it("throws NOT_FOUND when bot does not exist", async () => {
    fleetMock.profiles.get.mockResolvedValue(null);
    const caller = createCaller(authedContext());
    await expect(caller.fleet.activateCapability({ id: TEST_BOT_ID, capabilityId: "tts" })).rejects.toMatchObject({
      message: "Bot not found",
    });
  });

  it("rejects unauthenticated", async () => {
    const caller = createCaller(unauthContext());
    await expect(caller.fleet.activateCapability({ id: TEST_BOT_ID, capabilityId: "tts" })).rejects.toThrow(
      "Authentication required",
    );
  });
});

// ---------------------------------------------------------------------------
// getStorageTier
// ---------------------------------------------------------------------------

describe("fleet.getStorageTier", () => {
  it("returns standard tier when billing is null", async () => {
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getStorageTier({ id: TEST_BOT_ID });
    expect(result).toEqual({ tier: "standard", limitGb: 5, dailyCost: 0 });
  });

  it("returns tier from billing when available", async () => {
    const mockBilling = { getStorageTier: vi.fn().mockReturnValue("pro") };
    setFleetRouterDeps({
      getFleetManager: () => fleetMock as unknown as FleetManager,
      getTemplates: () => mockTemplates,
      getCreditLedger: () => null,
      getBotBilling: () => mockBilling as never,
    });
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getStorageTier({ id: TEST_BOT_ID });
    expect(result).toEqual({ tier: "pro", limitGb: 50, dailyCost: 8 });
  });

  it("throws NOT_FOUND for non-owned bot", async () => {
    fleetMock.profiles.get.mockResolvedValue({ ...mockProfile, tenantId: "other-tenant" });
    const caller = createCaller(authedContext());
    await expect(caller.fleet.getStorageTier({ id: TEST_BOT_ID })).rejects.toMatchObject({
      message: "Bot not found",
    });
  });
});

// ---------------------------------------------------------------------------
// setStorageTier
// ---------------------------------------------------------------------------

describe("fleet.setStorageTier", () => {
  it("rejects invalid tier (Zod validation)", async () => {
    const caller = createCaller(authedContext());
    await expect(caller.fleet.setStorageTier({ id: TEST_BOT_ID, tier: "invalid" as never })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("rejects upgrade with insufficient credits", async () => {
    const mockLedger = { balance: vi.fn().mockResolvedValue(Credit.fromCents(2)) };
    setFleetRouterDeps({
      getFleetManager: () => fleetMock as unknown as FleetManager,
      getTemplates: () => mockTemplates,
      getCreditLedger: () => mockLedger as never,
      getBotBilling: () => ({ getStorageTier: vi.fn().mockReturnValue("standard"), setStorageTier: vi.fn() }) as never,
    });
    const caller = createCaller(authedContext());
    await expect(caller.fleet.setStorageTier({ id: TEST_BOT_ID, tier: "plus" })).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
    });
  });

  it("rejects downgrade when usage exceeds new tier limit", async () => {
    // Currently on max (100GB), trying to downgrade to standard (5GB), but 25GB used
    const mockBilling = {
      getStorageTier: vi.fn().mockReturnValue("max"),
      setStorageTier: vi.fn(),
    };
    fleetMock.getVolumeUsage.mockResolvedValue({
      usedBytes: 25 * 1024 ** 3, // 25GB
      totalBytes: 100 * 1024 ** 3,
      availableBytes: 75 * 1024 ** 3,
    });
    setFleetRouterDeps({
      getFleetManager: () => fleetMock as unknown as FleetManager,
      getTemplates: () => mockTemplates,
      getCreditLedger: () => null,
      getBotBilling: () => mockBilling as never,
    });
    const caller = createCaller(authedContext());
    await expect(caller.fleet.setStorageTier({ id: TEST_BOT_ID, tier: "standard" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("updates storage tier successfully", async () => {
    const mockBilling = {
      getStorageTier: vi.fn().mockReturnValue("standard"),
      setStorageTier: vi.fn(),
    };
    const mockLedger = { balance: vi.fn().mockResolvedValue(Credit.fromCents(1000)) };
    setFleetRouterDeps({
      getFleetManager: () => fleetMock as unknown as FleetManager,
      getTemplates: () => mockTemplates,
      getCreditLedger: () => mockLedger as never,
      getBotBilling: () => mockBilling as never,
    });
    const caller = createCaller(authedContext());
    const result = await caller.fleet.setStorageTier({ id: TEST_BOT_ID, tier: "plus" });
    expect(result).toEqual({ tier: "plus", limitGb: 20, dailyCost: 3 });
    expect(mockBilling.setStorageTier).toHaveBeenCalledWith(TEST_BOT_ID, "plus");
  });
});

// ---------------------------------------------------------------------------
// getStorageUsage
// ---------------------------------------------------------------------------

describe("fleet.getStorageUsage", () => {
  it("returns zero usage for stopped bot", async () => {
    fleetMock.getVolumeUsage.mockResolvedValue(null);
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getStorageUsage({ id: TEST_BOT_ID });
    expect(result).toMatchObject({
      tier: "standard",
      limitGb: 5,
      usedBytes: 0,
      usedGb: 0,
      percentUsed: 0,
      dailyCost: 0,
    });
  });

  it("returns live disk usage for running bot", async () => {
    const mockBilling = { getStorageTier: vi.fn().mockReturnValue("pro") };
    fleetMock.getVolumeUsage.mockResolvedValue({
      usedBytes: 10 * 1024 ** 3, // 10GB
      totalBytes: 50 * 1024 ** 3,
      availableBytes: 40 * 1024 ** 3,
    });
    setFleetRouterDeps({
      getFleetManager: () => fleetMock as unknown as FleetManager,
      getTemplates: () => mockTemplates,
      getCreditLedger: () => null,
      getBotBilling: () => mockBilling as never,
    });
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getStorageUsage({ id: TEST_BOT_ID });
    expect(result.tier).toBe("pro");
    expect(result.limitGb).toBe(50);
    expect(result.usedGb).toBe(10);
    expect(result.percentUsed).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// org-scoped bot ownership (WOP-1002)
// ---------------------------------------------------------------------------

describe("org-scoped bot ownership (WOP-1002)", () => {
  function createBotInstanceRepoMock(overrides: Partial<BotInstance> = {}): IBotInstanceRepository {
    return {
      getById: vi.fn().mockReturnValue({ ...mockBotInstance, ...overrides }),
      listByTenant: vi.fn().mockReturnValue([{ ...mockBotInstance, ...overrides }]),
      listByNode: vi.fn().mockReturnValue([]),
      create: vi.fn().mockReturnValue({ ...mockBotInstance, ...overrides }),
      reassign: vi.fn(),
      setBillingState: vi.fn(),
      getResourceTier: vi.fn().mockReturnValue("standard"),
      setResourceTier: vi.fn(),
      getStorageTier: vi.fn().mockReturnValue("standard"),
      setStorageTier: vi.fn(),
    } as unknown as IBotInstanceRepository;
  }

  function createRoleStoreMock(role: string | null): RoleStore {
    return { getRole: vi.fn().mockReturnValue(role) } as unknown as RoleStore;
  }

  it("user role member cannot control another user's bot", async () => {
    const ctx = authedContext({ user: { id: "user-B", roles: ["user"] } });
    const caller = createCaller(ctx);

    const botRepo = createBotInstanceRepoMock({ createdByUserId: "user-A" });
    const roleStore = createRoleStoreMock("user");

    setFleetRouterDeps({
      getFleetManager: () => fleetMock as unknown as FleetManager,
      getTemplates: () => mockTemplates,
      getCreditLedger: () => null,
      getBotInstanceRepo: () => botRepo,
      getRoleStore: () => roleStore,
    });

    await expect(caller.fleet.controlInstance({ id: TEST_BOT_ID, action: "stop" })).rejects.toMatchObject({
      message: "You do not have permission to manage this bot",
    });
  });

  it("tenant_admin can control any org bot", async () => {
    const ctx = authedContext({ user: { id: "admin-user", roles: ["admin"] } });
    const caller = createCaller(ctx);

    const botRepo = createBotInstanceRepoMock({ createdByUserId: "other-user" });
    const roleStore = createRoleStoreMock("tenant_admin");

    setFleetRouterDeps({
      getFleetManager: () => fleetMock as unknown as FleetManager,
      getTemplates: () => mockTemplates,
      getCreditLedger: () => null,
      getBotInstanceRepo: () => botRepo,
      getRoleStore: () => roleStore,
    });

    const result = await caller.fleet.controlInstance({ id: TEST_BOT_ID, action: "stop" });
    expect(result).toEqual({ ok: true });
  });

  it("user can control their own bot", async () => {
    const ctx = authedContext({ user: { id: "test-user", roles: ["user"] } });
    const caller = createCaller(ctx);

    const botRepo = createBotInstanceRepoMock({ createdByUserId: "test-user" });
    const roleStore = createRoleStoreMock("user");

    setFleetRouterDeps({
      getFleetManager: () => fleetMock as unknown as FleetManager,
      getTemplates: () => mockTemplates,
      getCreditLedger: () => null,
      getBotInstanceRepo: () => botRepo,
      getRoleStore: () => roleStore,
    });

    const result = await caller.fleet.controlInstance({ id: TEST_BOT_ID, action: "stop" });
    expect(result).toEqual({ ok: true });
  });

  it("listInstances returns all org bots regardless of creator", async () => {
    const ctx = authedContext({ user: { id: "user-B", roles: ["user"] } });
    const caller = createCaller(ctx);
    fleetMock.listByTenant.mockResolvedValue([mockStatus]);
    const result = await caller.fleet.listInstances();
    expect(result.bots).toHaveLength(1);
  });
});
