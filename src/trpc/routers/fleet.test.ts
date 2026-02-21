/**
 * Unit tests for the tRPC fleet router.
 *
 * Uses the caller pattern — no HTTP transport needed, tests run against
 * the router directly via appRouter.createCaller(ctx).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetManager } from "../../fleet/fleet-manager.js";
import { BotNotFoundError } from "../../fleet/fleet-manager.js";
import type { ProfileTemplate } from "../../fleet/profile-schema.js";
import { appRouter } from "../index.js";
import type { TRPCContext } from "../init.js";
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
  uptime: "2026-01-01T00:00:00Z",
  startedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  stats: { cpuPercent: 5.2, memoryUsageMb: 128, memoryLimitMb: 512, memoryPercent: 25.0 },
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
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    logs: vi.fn().mockResolvedValue("2026-01-01T00:00:00Z log line 1\n"),
    profiles: {
      get: vi.fn().mockResolvedValue(mockProfile),
    },
  };
}

let fleetMock: ReturnType<typeof createFleetMock>;

beforeEach(() => {
  fleetMock = createFleetMock();
  setFleetRouterDeps({
    getFleetManager: () => fleetMock as unknown as FleetManager,
    getTemplates: () => mockTemplates,
    getCreditLedger: () => null,
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
    fleetMock.logs.mockResolvedValue("2026-01-01T00:00:00Z log line 1\n2026-01-01T00:00:01Z log line 2");
    const caller = createCaller(authedContext());
    const result = await caller.fleet.getInstanceLogs({ id: TEST_BOT_ID });
    expect(result).toEqual({
      logs: ["2026-01-01T00:00:00Z log line 1", "2026-01-01T00:00:01Z log line 2"],
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
