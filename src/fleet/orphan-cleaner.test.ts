import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeConnectionManager } from "./node-connection-manager.js";
import { OrphanCleaner } from "./orphan-cleaner.js";

const NODE_ID = "node-1";

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

/**
 * Build a mock db where select().from(botInstances).where(...).all()
 * returns the given instances, .get() returns a node status row,
 * update/insert chains work, and transaction() invokes the callback
 * with a tx object that has the same update/insert interface.
 */
function makeDb(instances: Array<{ tenantId: string; nodeId: string | null }>, nodeStatus = "returning") {
  const runFn = vi.fn();

  const makeUpdateChain = () =>
    vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          run: runFn,
        }),
      }),
    });

  const makeInsertChain = () =>
    vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        run: vi.fn(),
      }),
    });

  const tx = {
    update: makeUpdateChain(),
    insert: makeInsertChain(),
  };

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue(instances),
          get: vi.fn().mockReturnValue({ status: nodeStatus }),
        }),
      }),
    }),
    update: makeUpdateChain(),
    insert: makeInsertChain(),
    transaction: vi.fn().mockImplementation((fn: (tx: unknown) => void) => fn(tx)),
    _runFn: runFn,
    _tx: tx,
  };
}

describe("OrphanCleaner.clean", () => {
  let nodeConnections: NodeConnectionManager;

  beforeEach(() => {
    nodeConnections = makeNodeConnections();
    vi.clearAllMocks();
  });

  it("stops containers assigned to a different node", async () => {
    // tenant_orphan is running on node-1 but bot_instances says only "keep-me" belongs here
    const db = makeDb([{ tenantId: "keep-me", nodeId: NODE_ID }]);
    const sendCommand = vi.fn().mockResolvedValue({ success: true });
    nodeConnections = makeNodeConnections({ sendCommand });

    const cleaner = new OrphanCleaner(db as never, nodeConnections);

    const result = await cleaner.clean({
      nodeId: NODE_ID,
      runningContainers: ["tenant_orphan", "tenant_keep-me"],
    });

    // tenant_orphan is NOT in the db result for this node -> orphan -> should be stopped
    expect(sendCommand).toHaveBeenCalledWith(NODE_ID, {
      type: "bot.stop",
      payload: { name: "tenant_orphan" },
    });
    expect(result.stopped).toContain("tenant_orphan");
    // tenant_keep-me IS assigned to this node -> should NOT be stopped
    expect(result.kept).toContain("tenant_keep-me");
  });

  it("does NOT stop containers still assigned to this node", async () => {
    const db = makeDb([{ tenantId: "mine", nodeId: NODE_ID }]);
    const sendCommand = vi.fn().mockResolvedValue({ success: true });
    nodeConnections = makeNodeConnections({ sendCommand });

    const cleaner = new OrphanCleaner(db as never, nodeConnections);

    const result = await cleaner.clean({
      nodeId: NODE_ID,
      runningContainers: ["tenant_mine"],
    });

    // Should NOT have sent any stop command
    expect(sendCommand).not.toHaveBeenCalled();
    expect(result.stopped).toHaveLength(0);
    expect(result.kept).toContain("tenant_mine");
  });

  it("transitions node to active after cleanup even if nothing to stop", async () => {
    const db = makeDb([]);
    const cleaner = new OrphanCleaner(db as never, nodeConnections);

    const result = await cleaner.clean({
      nodeId: NODE_ID,
      runningContainers: [],
    });

    // Status update and audit insert must run inside a transaction
    expect(db.transaction).toHaveBeenCalled();

    // Check that set was called with status: "active" on the tx object
    const setCalls = (db._tx.update().set as ReturnType<typeof vi.fn>).mock.calls;
    const activeCall = setCalls.find((call: unknown[]) => (call[0] as Record<string, unknown>)?.status === "active");
    expect(activeCall).toBeDefined();

    expect(result.nodeId).toBe(NODE_ID);
    expect(result.stopped).toHaveLength(0);
    expect(result.kept).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("uses the node's current status as fromStatus in the audit row", async () => {
    const db = makeDb([], "recovering");
    const cleaner = new OrphanCleaner(db as never, nodeConnections);

    await cleaner.clean({ nodeId: NODE_ID, runningContainers: [] });

    const insertValues = (db._tx.insert().values as ReturnType<typeof vi.fn>).mock.calls;
    const auditCall = insertValues.find(
      (call: unknown[]) => (call[0] as Record<string, unknown>)?.fromStatus === "recovering",
    );
    expect(auditCall).toBeDefined();
  });
});
