import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminNotifier } from "./admin-notifier.js";
import { MigrationManager } from "./migration-manager.js";
import type { NodeConnectionManager, TenantAssignment } from "./node-connection-manager.js";

function makeDb(instance: Record<string, unknown> | undefined) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(instance),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          run: vi.fn(),
        }),
      }),
    }),
  };
}

function makeNodeConnections(overrides: Partial<NodeConnectionManager> = {}): NodeConnectionManager {
  return {
    sendCommand: vi.fn().mockResolvedValue({ success: true }),
    reassignTenant: vi.fn(),
    addNodeCapacity: vi.fn(),
    getNodeTenants: vi.fn().mockReturnValue([]),
    registerNode: vi.fn(),
    handleWebSocket: vi.fn(),
    listNodes: vi.fn().mockReturnValue([]),
    findBestTarget: vi.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as NodeConnectionManager;
}

function makeNotifier(): AdminNotifier {
  return {
    nodeRecoveryComplete: vi.fn().mockResolvedValue(undefined),
    nodeStatusChange: vi.fn().mockResolvedValue(undefined),
    capacityOverflow: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdminNotifier;
}

const BOT_ID = "bot-123";
const SOURCE_NODE = "node-1";
const TARGET_NODE = "node-2";
const TENANT_ID = "tenant-abc";

const defaultInstance = {
  id: BOT_ID,
  tenantId: TENANT_ID,
  nodeId: SOURCE_NODE,
  name: "My Bot",
};

describe("MigrationManager.migrateTenant", () => {
  let nodeConnections: NodeConnectionManager;
  let notifier: AdminNotifier;

  beforeEach(() => {
    nodeConnections = makeNodeConnections();
    notifier = makeNotifier();
    vi.clearAllMocks();
  });

  it("returns error when bot instance not found", async () => {
    const db = makeDb(undefined);
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    const result = await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(result.sourceNodeId).toBe("unknown");
  });

  it("returns error when bot has no assigned node", async () => {
    const db = makeDb({ ...defaultInstance, nodeId: null });
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    const result = await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no assigned node/i);
    expect(result.sourceNodeId).toBe("unassigned");
  });

  it("returns error when source and target are the same node", async () => {
    const db = makeDb(defaultInstance);
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    const result = await mgr.migrateTenant(BOT_ID, SOURCE_NODE);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/same node/i);
  });

  it("succeeds on happy path with explicit target", async () => {
    const db = makeDb(defaultInstance);
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    const result = await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(true);
    expect(result.botId).toBe(BOT_ID);
    expect(result.sourceNodeId).toBe(SOURCE_NODE);
    expect(result.targetNodeId).toBe(TARGET_NODE);
    expect(result.downtimeMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("sends commands in correct order on happy path", async () => {
    const db = makeDb(defaultInstance);
    const sendCommand = vi.fn().mockResolvedValue({ success: true });
    nodeConnections = makeNodeConnections({ sendCommand });
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    const calls = (sendCommand as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual([SOURCE_NODE, { type: "bot.export", payload: { name: `tenant_${TENANT_ID}` } }]);
    expect(calls[1]).toEqual([
      SOURCE_NODE,
      { type: "backup.upload", payload: { filename: `tenant_${TENANT_ID}.tar.gz` } },
    ]);
    expect(calls[2]).toEqual([
      TARGET_NODE,
      { type: "backup.download", payload: { filename: `tenant_${TENANT_ID}.tar.gz` } },
    ]);
    expect(calls[3]).toEqual([SOURCE_NODE, { type: "bot.stop", payload: { name: `tenant_${TENANT_ID}` } }]);
    expect(calls[4][0]).toEqual(TARGET_NODE);
    expect(calls[4][1].type).toEqual("bot.import");
    expect(calls[5]).toEqual([TARGET_NODE, { type: "bot.inspect", payload: { name: `tenant_${TENANT_ID}` } }]);
  });

  it("updates routing table after successful migration", async () => {
    const db = makeDb(defaultInstance);
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    expect(nodeConnections.reassignTenant).toHaveBeenCalledWith(BOT_ID, TARGET_NODE);
  });

  it("persists bot_instances.node_id to DB after successful migration", async () => {
    const runMock = vi.fn();
    const whereMock = vi.fn().mockReturnValue({ run: runMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    const updateMock = vi.fn().mockReturnValue({ set: setMock });

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(defaultInstance),
          }),
        }),
      }),
      update: updateMock,
    };

    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    // DB update should have been called to persist nodeId
    expect(updateMock).toHaveBeenCalled();
    const setCall = (setMock as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0]?.nodeId === TARGET_NODE);
    expect(setCall).toBeDefined();
    expect(setCall?.[0]?.nodeId).toBe(TARGET_NODE);
    expect(runMock).toHaveBeenCalled();
  });

  it("does not persist node_id to DB when migration fails", async () => {
    const runMock = vi.fn();
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ run: runMock }),
    });
    const updateMock = vi.fn().mockReturnValue({ set: setMock });

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(defaultInstance),
          }),
        }),
      }),
      update: updateMock,
    };

    const sendCommand = vi.fn().mockRejectedValue(new Error("Export failed"));
    nodeConnections = makeNodeConnections({ sendCommand });
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    const result = await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(false);
    // No DB update with nodeId should have been called
    const setCallWithNodeId = (setMock as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.nodeId !== undefined,
    );
    expect(setCallWithNodeId).toBeUndefined();
  });

  it("updates node capacity tracking on both source and target", async () => {
    const db = makeDb(defaultInstance);
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    expect(nodeConnections.addNodeCapacity).toHaveBeenCalledWith(TARGET_NODE, 100);
    expect(nodeConnections.addNodeCapacity).toHaveBeenCalledWith(SOURCE_NODE, -100);
  });

  it("returns error when export command fails", async () => {
    const db = makeDb(defaultInstance);
    const sendCommand = vi.fn().mockRejectedValue(new Error("Export failed"));
    nodeConnections = makeNodeConnections({ sendCommand });
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    const result = await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/export failed/i);
    // Routing table should NOT have been updated
    expect(nodeConnections.reassignTenant).not.toHaveBeenCalled();
  });

  it("returns error when import command fails", async () => {
    const db = makeDb(defaultInstance);
    let callCount = 0;
    const sendCommand = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 5) throw new Error("Import failed");
      return Promise.resolve({ success: true });
    });
    nodeConnections = makeNodeConnections({ sendCommand });
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    const result = await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/import failed/i);
    expect(nodeConnections.reassignTenant).not.toHaveBeenCalled();
  });

  it("returns error when verify command fails", async () => {
    const db = makeDb(defaultInstance);
    let callCount = 0;
    const sendCommand = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 6) throw new Error("Verify failed");
      return Promise.resolve({ success: true });
    });
    nodeConnections = makeNodeConnections({ sendCommand });
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    const result = await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/verify failed/i);
    expect(nodeConnections.reassignTenant).not.toHaveBeenCalled();
  });

  it("returns error when no capacity and no explicit target", async () => {
    const db = makeDb(defaultInstance);
    // placement.findPlacementExcluding will query db.select() again
    // We mock the DB to return null for placement
    const selectMock = vi.fn();
    let callCount = 0;
    selectMock.mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return defaultInstance; // First call: bot instance lookup
            return null; // Second call: placement query
          }),
          limit: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(null), // placement returns null
          }),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              get: vi.fn().mockReturnValue(null),
            }),
          }),
        }),
      }),
    }));
    const db2 = { ...db, select: selectMock };
    const mgr = new MigrationManager(db2 as never, nodeConnections, notifier);

    const result = await mgr.migrateTenant(BOT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no node with sufficient capacity/i);
  });

  it("includes downtimeMs in result", async () => {
    const db = makeDb(defaultInstance);
    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    const result = await mgr.migrateTenant(BOT_ID, TARGET_NODE);

    expect(result.downtimeMs).toBeDefined();
    expect(typeof result.downtimeMs).toBe("number");
    expect(result.downtimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe("MigrationManager.drainNode", () => {
  let notifier: AdminNotifier;

  beforeEach(() => {
    notifier = makeNotifier();
    vi.clearAllMocks();
  });

  it("migrates all tenants from node", async () => {
    const tenants: TenantAssignment[] = [
      { id: "bot-1", tenantId: "tenant-1", name: "Bot 1", containerName: "tenant_1", estimatedMb: 100 },
      { id: "bot-2", tenantId: "tenant-2", name: "Bot 2", containerName: "tenant_2", estimatedMb: 100 },
    ];

    const getNodeTenants = vi.fn().mockReturnValue(tenants);
    const nodeConnections = makeNodeConnections({ getNodeTenants });

    // Each bot lookup succeeds with different node assignments
    const db = {
      select: vi.fn(),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ run: vi.fn() }),
        }),
      }),
    };
    let selectCallCount = 0;
    db.select.mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount % 2 === 1) {
              // Bot lookup
              const idx = Math.ceil(selectCallCount / 2) - 1;
              return {
                id: tenants[idx]?.id,
                tenantId: tenants[idx]?.tenantId,
                nodeId: SOURCE_NODE,
                name: tenants[idx]?.name,
              };
            }
            return null;
          }),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              get: vi.fn().mockReturnValue({ nodeId: TARGET_NODE, host: "10.0.0.2", availableMb: 1000 }),
            }),
          }),
        }),
      }),
    }));

    const mgr = new MigrationManager(db as never, nodeConnections, notifier);

    // Mock migrateTenant to succeed
    const migrateTenantSpy = vi.spyOn(mgr, "migrateTenant").mockResolvedValue({
      success: true,
      botId: "bot-1",
      sourceNodeId: SOURCE_NODE,
      targetNodeId: TARGET_NODE,
      downtimeMs: 10,
    });

    const result = await mgr.drainNode(SOURCE_NODE);

    expect(migrateTenantSpy).toHaveBeenCalledTimes(2);
    expect(result.migrated).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.nodeId).toBe(SOURCE_NODE);
  });

  it("marks node as offline when all tenants migrate successfully", async () => {
    const tenants: TenantAssignment[] = [
      { id: "bot-1", tenantId: "tenant-1", name: "Bot 1", containerName: "tenant_1", estimatedMb: 100 },
    ];

    const getNodeTenants = vi.fn().mockReturnValue(tenants);
    const nodeConnections = makeNodeConnections({ getNodeTenants });
    const runMock = vi.fn();
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(defaultInstance) }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ run: runMock }),
        }),
      }),
    };

    const mgr = new MigrationManager(db as never, nodeConnections, notifier);
    vi.spyOn(mgr, "migrateTenant").mockResolvedValue({
      success: true,
      botId: "bot-1",
      sourceNodeId: SOURCE_NODE,
      targetNodeId: TARGET_NODE,
      downtimeMs: 10,
    });

    await mgr.drainNode(SOURCE_NODE);

    // The second update call should set status to "offline"
    const setMock = db.update().set;
    const lastSetCall = (setMock as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(lastSetCall?.[0]?.status).toBe("offline");
  });

  it("marks node as still draining when some tenants fail", async () => {
    const tenants: TenantAssignment[] = [
      { id: "bot-1", tenantId: "tenant-1", name: "Bot 1", containerName: "tenant_1", estimatedMb: 100 },
      { id: "bot-2", tenantId: "tenant-2", name: "Bot 2", containerName: "tenant_2", estimatedMb: 100 },
    ];

    const getNodeTenants = vi.fn().mockReturnValue(tenants);
    const nodeConnections = makeNodeConnections({ getNodeTenants });
    const runMock = vi.fn();
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(defaultInstance) }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ run: runMock }),
        }),
      }),
    };

    const mgr = new MigrationManager(db as never, nodeConnections, notifier);
    let callIdx = 0;
    vi.spyOn(mgr, "migrateTenant").mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) {
        return { success: true, botId: "bot-1", sourceNodeId: SOURCE_NODE, targetNodeId: TARGET_NODE, downtimeMs: 10 };
      }
      return {
        success: false,
        botId: "bot-2",
        sourceNodeId: SOURCE_NODE,
        targetNodeId: "none",
        downtimeMs: 0,
        error: "No capacity",
      };
    });

    const result = await mgr.drainNode(SOURCE_NODE);

    expect(result.migrated).toHaveLength(1);
    expect(result.failed).toHaveLength(1);

    // Should stay "draining" since there were failures
    const setMock = db.update().set;
    const lastSetCall = (setMock as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(lastSetCall?.[0]?.status).toBe("draining");
  });

  it("notifies admin when there are capacity failures", async () => {
    const tenants: TenantAssignment[] = [
      { id: "bot-1", tenantId: "tenant-1", name: "Bot 1", containerName: "tenant_1", estimatedMb: 100 },
    ];

    const getNodeTenants = vi.fn().mockReturnValue(tenants);
    const nodeConnections = makeNodeConnections({ getNodeTenants });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(defaultInstance) }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ run: vi.fn() }),
        }),
      }),
    };

    const mgr = new MigrationManager(db as never, nodeConnections, notifier);
    vi.spyOn(mgr, "migrateTenant").mockResolvedValue({
      success: false,
      botId: "bot-1",
      sourceNodeId: SOURCE_NODE,
      targetNodeId: "none",
      downtimeMs: 0,
      error: "No capacity",
    });

    await mgr.drainNode(SOURCE_NODE);

    expect(notifier.capacityOverflow).toHaveBeenCalledWith(SOURCE_NODE, 1, 1);
  });

  it("does not call notifier when all tenants migrate successfully", async () => {
    const tenants: TenantAssignment[] = [
      { id: "bot-1", tenantId: "tenant-1", name: "Bot 1", containerName: "tenant_1", estimatedMb: 100 },
    ];

    const getNodeTenants = vi.fn().mockReturnValue(tenants);
    const nodeConnections = makeNodeConnections({ getNodeTenants });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(defaultInstance) }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ run: vi.fn() }),
        }),
      }),
    };

    const mgr = new MigrationManager(db as never, nodeConnections, notifier);
    vi.spyOn(mgr, "migrateTenant").mockResolvedValue({
      success: true,
      botId: "bot-1",
      sourceNodeId: SOURCE_NODE,
      targetNodeId: TARGET_NODE,
      downtimeMs: 10,
    });

    await mgr.drainNode(SOURCE_NODE);

    expect(notifier.capacityOverflow).not.toHaveBeenCalled();
  });

  it("marks node as draining at the start", async () => {
    const getNodeTenants = vi.fn().mockReturnValue([]);
    const nodeConnections = makeNodeConnections({ getNodeTenants });
    const runMock = vi.fn();
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(defaultInstance) }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ run: runMock }),
        }),
      }),
    };

    const mgr = new MigrationManager(db as never, nodeConnections, notifier);
    await mgr.drainNode(SOURCE_NODE);

    // First update call should set status to "draining"
    const setMock = db.update().set;
    const firstSetCall = (setMock as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstSetCall?.[0]?.status).toBe("draining");
  });
});
