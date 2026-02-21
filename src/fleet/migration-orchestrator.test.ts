import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import { MigrationOrchestrator } from "./migration-orchestrator.js";
import type { INodeCommandBus } from "./node-command-bus.js";
import type { INodeRepository } from "./node-repository.js";

const BOT_ID = "bot-123";
const SOURCE_NODE = "node-1";
const TARGET_NODE = "node-2";
const TENANT_ID = "tenant-abc";

const defaultInstance = {
  id: BOT_ID,
  tenantId: TENANT_ID,
  name: "My Bot",
  nodeId: SOURCE_NODE,
  billingState: "active" as const,
  suspendedAt: null,
  destroyAfter: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function makeCommandBus(overrides: Partial<INodeCommandBus> = {}): INodeCommandBus {
  return {
    send: vi.fn().mockResolvedValue({ id: "cmd-1", type: "command_result", command: "test", success: true }),
    ...overrides,
  } as INodeCommandBus;
}

function makeBotInstanceRepo(instance = defaultInstance): IBotInstanceRepository {
  return {
    getById: vi.fn().mockReturnValue(instance),
    listByNode: vi.fn().mockReturnValue([]),
    listByTenant: vi.fn().mockReturnValue([]),
    create: vi.fn(),
    reassign: vi.fn().mockReturnValue({ ...instance, nodeId: TARGET_NODE }),
    setBillingState: vi.fn(),
  } as unknown as IBotInstanceRepository;
}

function makeNodeRepo(): INodeRepository {
  return {
    getById: vi.fn().mockReturnValue({ id: SOURCE_NODE, status: "active", capacityMb: 2048, usedMb: 100 }),
    list: vi.fn().mockReturnValue([]),
    register: vi.fn(),
    transition: vi.fn().mockReturnValue({ id: SOURCE_NODE, status: "active" }),
    updateHeartbeat: vi.fn(),
    addCapacity: vi.fn(),
    findBestTarget: vi.fn().mockReturnValue({ id: TARGET_NODE, host: "10.0.0.2", capacityMb: 1000, usedMb: 0 }),
    listTransitions: vi.fn().mockReturnValue([]),
  } as unknown as INodeRepository;
}

describe("MigrationOrchestrator.migrate", () => {
  let commandBus: INodeCommandBus;
  let botInstanceRepo: IBotInstanceRepository;
  let nodeRepo: INodeRepository;

  beforeEach(() => {
    commandBus = makeCommandBus();
    botInstanceRepo = makeBotInstanceRepo();
    nodeRepo = makeNodeRepo();
    vi.clearAllMocks();
  });

  it("returns error when bot instance not found", async () => {
    (botInstanceRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const orch = new MigrationOrchestrator(commandBus, botInstanceRepo, nodeRepo);

    const result = await orch.migrate(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("returns error when bot has no assigned node", async () => {
    (botInstanceRepo.getById as ReturnType<typeof vi.fn>).mockReturnValue({ ...defaultInstance, nodeId: null });
    const orch = new MigrationOrchestrator(commandBus, botInstanceRepo, nodeRepo);

    const result = await orch.migrate(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no assigned node/i);
  });

  it("returns error when source and target are the same node", async () => {
    const orch = new MigrationOrchestrator(commandBus, botInstanceRepo, nodeRepo);

    const result = await orch.migrate(BOT_ID, SOURCE_NODE);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/same node/i);
  });

  it("succeeds on happy path with explicit target", async () => {
    const orch = new MigrationOrchestrator(commandBus, botInstanceRepo, nodeRepo);

    const result = await orch.migrate(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(true);
    expect(result.botId).toBe(BOT_ID);
    expect(result.sourceNodeId).toBe(SOURCE_NODE);
    expect(result.targetNodeId).toBe(TARGET_NODE);
    expect(result.downtimeMs).toBeGreaterThanOrEqual(0);
  });

  it("sends commands in correct order: export, upload, download, stop, import, inspect", async () => {
    const send = vi.fn().mockResolvedValue({ id: "cmd-1", type: "command_result", command: "test", success: true });
    commandBus = makeCommandBus({ send });
    const orch = new MigrationOrchestrator(commandBus, botInstanceRepo, nodeRepo);

    await orch.migrate(BOT_ID, TARGET_NODE);

    const calls = send.mock.calls;
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
    expect(calls[4][0]).toBe(TARGET_NODE);
    expect(calls[4][1].type).toBe("bot.import");
    expect(calls[5]).toEqual([TARGET_NODE, { type: "bot.inspect", payload: { name: `tenant_${TENANT_ID}` } }]);
  });

  it("calls botInstanceRepo.reassign after successful migration", async () => {
    const orch = new MigrationOrchestrator(commandBus, botInstanceRepo, nodeRepo);

    await orch.migrate(BOT_ID, TARGET_NODE);

    expect(botInstanceRepo.reassign).toHaveBeenCalledWith(BOT_ID, TARGET_NODE);
  });

  it("does not call reassign when migration fails early", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Export failed"));
    commandBus = makeCommandBus({ send });
    const orch = new MigrationOrchestrator(commandBus, botInstanceRepo, nodeRepo);

    const result = await orch.migrate(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(false);
    expect(botInstanceRepo.reassign).not.toHaveBeenCalled();
  });

  it("restarts source container when import fails after stop (rollback)", async () => {
    let callCount = 0;
    const send = vi.fn().mockImplementation((_nodeId: string, cmd: { type: string }) => {
      callCount++;
      // Call 5 = bot.import on target → fail
      if (callCount === 5) return Promise.reject(new Error("Import failed"));
      return Promise.resolve({ id: "cmd-1", type: "command_result", command: cmd.type, success: true });
    });
    commandBus = makeCommandBus({ send });
    const orch = new MigrationOrchestrator(commandBus, botInstanceRepo, nodeRepo);

    const result = await orch.migrate(BOT_ID, TARGET_NODE);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/import failed/i);
    // Should have attempted rollback: bot.start on source
    const startCall = send.mock.calls.find(
      (c: unknown[]) => (c[1] as { type: string }).type === "bot.start" && c[0] === SOURCE_NODE,
    );
    expect(startCall).toBeDefined();
  });

  it("auto-selects target via nodeRepo.findBestTarget when no target specified", async () => {
    const orch = new MigrationOrchestrator(commandBus, botInstanceRepo, nodeRepo);

    const result = await orch.migrate(BOT_ID);

    expect(result.success).toBe(true);
    expect(result.targetNodeId).toBe(TARGET_NODE);
    expect(nodeRepo.findBestTarget).toHaveBeenCalledWith(SOURCE_NODE, 100);
  });

  it("returns error when no placement found and no explicit target", async () => {
    (nodeRepo.findBestTarget as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const orch = new MigrationOrchestrator(commandBus, botInstanceRepo, nodeRepo);

    const result = await orch.migrate(BOT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no node with sufficient capacity/i);
  });
});

import type { AdminNotifier } from "./admin-notifier.js";
// ---------------------------------------------------------------------------
// NodeDrainer tests
// ---------------------------------------------------------------------------
import { NodeDrainer } from "./node-drainer.js";

function makeNotifier(): AdminNotifier {
  return {
    nodeRecoveryComplete: vi.fn().mockResolvedValue(undefined),
    nodeStatusChange: vi.fn().mockResolvedValue(undefined),
    capacityOverflow: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdminNotifier;
}

describe("NodeDrainer.drain", () => {
  let commandBus: INodeCommandBus;
  let botInstanceRepo: IBotInstanceRepository;
  let nodeRepo: INodeRepository;
  let notifier: AdminNotifier;
  let orchestrator: MigrationOrchestrator;

  beforeEach(() => {
    commandBus = makeCommandBus();
    botInstanceRepo = makeBotInstanceRepo();
    nodeRepo = makeNodeRepo();
    notifier = makeNotifier();
    orchestrator = new MigrationOrchestrator(commandBus, botInstanceRepo, nodeRepo);
    vi.clearAllMocks();
  });

  it("transitions node to draining, then offline on full success", async () => {
    (botInstanceRepo.listByNode as ReturnType<typeof vi.fn>).mockReturnValue([
      { ...defaultInstance, id: "bot-1", tenantId: "t1" },
    ]);
    vi.spyOn(orchestrator, "migrate").mockResolvedValue({
      success: true,
      botId: "bot-1",
      sourceNodeId: SOURCE_NODE,
      targetNodeId: TARGET_NODE,
      downtimeMs: 10,
    });

    const drainer = new NodeDrainer(orchestrator, nodeRepo, botInstanceRepo, notifier);
    const result = await drainer.drain(SOURCE_NODE);

    expect(nodeRepo.transition).toHaveBeenCalledWith(SOURCE_NODE, "draining", "node_drain", "migration_orchestrator");
    expect(result.migrated).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(nodeRepo.transition).toHaveBeenCalledWith(
      SOURCE_NODE,
      "offline",
      "drain_complete",
      "migration_orchestrator",
    );
  });

  it("stays draining when some tenants fail", async () => {
    (botInstanceRepo.listByNode as ReturnType<typeof vi.fn>).mockReturnValue([
      { ...defaultInstance, id: "bot-1", tenantId: "t1" },
      { ...defaultInstance, id: "bot-2", tenantId: "t2" },
    ]);
    let callIdx = 0;
    vi.spyOn(orchestrator, "migrate").mockImplementation(async () => {
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

    const drainer = new NodeDrainer(orchestrator, nodeRepo, botInstanceRepo, notifier);
    const result = await drainer.drain(SOURCE_NODE);

    expect(result.migrated).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    // Should NOT transition to offline -- stays draining
    const offlineCalls = (nodeRepo.transition as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: string[]) => c[1] === "offline",
    );
    expect(offlineCalls).toHaveLength(0);
  });

  it("notifies admin when there are failures", async () => {
    (botInstanceRepo.listByNode as ReturnType<typeof vi.fn>).mockReturnValue([
      { ...defaultInstance, id: "bot-1", tenantId: "t1" },
    ]);
    vi.spyOn(orchestrator, "migrate").mockResolvedValue({
      success: false,
      botId: "bot-1",
      sourceNodeId: SOURCE_NODE,
      targetNodeId: "none",
      downtimeMs: 0,
      error: "No capacity",
    });

    const drainer = new NodeDrainer(orchestrator, nodeRepo, botInstanceRepo, notifier);
    await drainer.drain(SOURCE_NODE);

    expect(notifier.capacityOverflow).toHaveBeenCalledWith(SOURCE_NODE, 1, 1);
  });

  it("does not notify admin when all tenants migrate", async () => {
    (botInstanceRepo.listByNode as ReturnType<typeof vi.fn>).mockReturnValue([
      { ...defaultInstance, id: "bot-1", tenantId: "t1" },
    ]);
    vi.spyOn(orchestrator, "migrate").mockResolvedValue({
      success: true,
      botId: "bot-1",
      sourceNodeId: SOURCE_NODE,
      targetNodeId: TARGET_NODE,
      downtimeMs: 10,
    });

    const drainer = new NodeDrainer(orchestrator, nodeRepo, botInstanceRepo, notifier);
    await drainer.drain(SOURCE_NODE);

    expect(notifier.capacityOverflow).not.toHaveBeenCalled();
  });

  it("handles empty node (no tenants)", async () => {
    (botInstanceRepo.listByNode as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const drainer = new NodeDrainer(orchestrator, nodeRepo, botInstanceRepo, notifier);
    const result = await drainer.drain(SOURCE_NODE);

    expect(result.migrated).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(nodeRepo.transition).toHaveBeenCalledWith(
      SOURCE_NODE,
      "offline",
      "drain_complete",
      "migration_orchestrator",
    );
  });
});
