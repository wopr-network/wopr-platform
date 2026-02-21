import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import type { INodeCommandBus } from "./node-command-bus.js";
import type { INodeRepository } from "./node-repository.js";
import { OrphanCleaner } from "./orphan-cleaner.js";

const NODE_ID = "node-1";

function makeNodeRepo(overrides: Partial<INodeRepository> = {}): INodeRepository {
  return {
    getById: vi.fn().mockReturnValue(null),
    getBySecret: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    register: vi.fn(),
    registerSelfHosted: vi.fn(),
    transition: vi.fn(),
    updateHeartbeat: vi.fn(),
    addCapacity: vi.fn(),
    findBestTarget: vi.fn().mockReturnValue(null),
    listTransitions: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as INodeRepository;
}

function makeBotInstanceRepo(
  instances: Array<{ tenantId: string; nodeId: string | null }> = [],
): IBotInstanceRepository {
  return {
    getById: vi.fn().mockReturnValue(null),
    listByNode: vi.fn().mockReturnValue(instances),
    listByTenant: vi.fn().mockReturnValue([]),
    create: vi.fn(),
    reassign: vi.fn(),
    setBillingState: vi.fn(),
  } as unknown as IBotInstanceRepository;
}

function makeCommandBus(
  sendResult = { id: "cmd-1", type: "command_result", command: "bot.stop", success: true },
): INodeCommandBus {
  return {
    send: vi.fn().mockResolvedValue(sendResult),
  } as unknown as INodeCommandBus;
}

describe("OrphanCleaner.clean", () => {
  let nodeRepo: INodeRepository;
  let commandBus: INodeCommandBus;

  beforeEach(() => {
    nodeRepo = makeNodeRepo();
    commandBus = makeCommandBus();
    vi.clearAllMocks();
  });

  it("stops containers assigned to a different node", async () => {
    const botInstanceRepo = makeBotInstanceRepo([{ tenantId: "keep-me", nodeId: NODE_ID }]);
    const send = vi.fn().mockResolvedValue({ id: "cmd-1", type: "command_result", command: "bot.stop", success: true });
    commandBus = { send } as unknown as INodeCommandBus;

    const cleaner = new OrphanCleaner(nodeRepo, botInstanceRepo, commandBus);

    const result = await cleaner.clean({
      nodeId: NODE_ID,
      runningContainers: ["tenant_orphan", "tenant_keep-me"],
    });

    // tenant_orphan is NOT in the db result for this node -> orphan -> should be stopped
    expect(send).toHaveBeenCalledWith(NODE_ID, {
      type: "bot.stop",
      payload: { name: "tenant_orphan" },
    });
    expect(result.stopped).toContain("tenant_orphan");
    // tenant_keep-me IS assigned to this node -> should NOT be stopped
    expect(result.kept).toContain("tenant_keep-me");
  });

  it("does NOT stop containers still assigned to this node", async () => {
    const botInstanceRepo = makeBotInstanceRepo([{ tenantId: "mine", nodeId: NODE_ID }]);
    const send = vi.fn().mockResolvedValue({ id: "cmd-1", type: "command_result", command: "bot.stop", success: true });
    commandBus = { send } as unknown as INodeCommandBus;

    const cleaner = new OrphanCleaner(nodeRepo, botInstanceRepo, commandBus);

    const result = await cleaner.clean({
      nodeId: NODE_ID,
      runningContainers: ["tenant_mine"],
    });

    // Should NOT have sent any stop command
    expect(send).not.toHaveBeenCalled();
    expect(result.stopped).toHaveLength(0);
    expect(result.kept).toContain("tenant_mine");
  });

  it("transitions node to active after cleanup even if nothing to stop", async () => {
    const botInstanceRepo = makeBotInstanceRepo([]);
    const cleaner = new OrphanCleaner(nodeRepo, botInstanceRepo, commandBus);

    const result = await cleaner.clean({
      nodeId: NODE_ID,
      runningContainers: [],
    });

    // Should have called transition to "active"
    expect(nodeRepo.transition).toHaveBeenCalledWith(NODE_ID, "active", "cleanup_complete", "orphan_cleaner");

    expect(result.nodeId).toBe(NODE_ID);
    expect(result.stopped).toHaveLength(0);
    expect(result.kept).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("pushes to errors and not stopped when send returns success: false", async () => {
    const botInstanceRepo = makeBotInstanceRepo([{ tenantId: "keep-me", nodeId: NODE_ID }]);
    const send = vi.fn().mockResolvedValue({
      id: "cmd-1",
      type: "command_result",
      command: "bot.stop",
      success: false,
      error: "container not found",
    });
    commandBus = { send } as unknown as INodeCommandBus;

    const cleaner = new OrphanCleaner(nodeRepo, botInstanceRepo, commandBus);

    const result = await cleaner.clean({
      nodeId: NODE_ID,
      runningContainers: ["tenant_orphan"],
    });

    expect(send).toHaveBeenCalledWith(NODE_ID, {
      type: "bot.stop",
      payload: { name: "tenant_orphan" },
    });
    expect(result.stopped).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      container: "tenant_orphan",
      error: "container not found",
    });
  });

  it("transitions node to active regardless of stop failures", async () => {
    const botInstanceRepo = makeBotInstanceRepo([]);
    const cleaner = new OrphanCleaner(nodeRepo, botInstanceRepo, commandBus);

    await cleaner.clean({ nodeId: NODE_ID, runningContainers: [] });

    expect(nodeRepo.transition).toHaveBeenCalledWith(NODE_ID, "active", "cleanup_complete", "orphan_cleaner");
  });
});
