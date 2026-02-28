import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminNotifier } from "./admin-notifier.js";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import type { MigrationOrchestrator, MigrationResult } from "./migration-orchestrator.js";
import { NodeDrainer } from "./node-drainer.js";
import type { INodeRepository } from "./node-repository.js";

const NODE_ID = "node-1";
const BOT_1 = "bot-1";
const BOT_2 = "bot-2";
const TENANT_1 = "tenant-1";
const TENANT_2 = "tenant-2";
const TARGET_NODE = "node-2";

const defaultInstance1 = {
  id: BOT_1,
  tenantId: TENANT_1,
  name: "Bot One",
  nodeId: NODE_ID,
  billingState: "active" as const,
  suspendedAt: null,
  destroyAfter: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const defaultInstance2 = {
  id: BOT_2,
  tenantId: TENANT_2,
  name: "Bot Two",
  nodeId: NODE_ID,
  billingState: "active" as const,
  suspendedAt: null,
  destroyAfter: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function successResult(botId: string): MigrationResult {
  return {
    success: true,
    botId,
    sourceNodeId: NODE_ID,
    targetNodeId: TARGET_NODE,
    downtimeMs: 50,
  };
}

function failureResult(botId: string): MigrationResult {
  return {
    success: false,
    botId,
    sourceNodeId: NODE_ID,
    targetNodeId: TARGET_NODE,
    downtimeMs: 0,
    error: "migration failed",
  };
}

function makeMigrationOrchestrator(overrides: Partial<MigrationOrchestrator> = {}): MigrationOrchestrator {
  return {
    migrate: vi.fn().mockResolvedValue(successResult(BOT_1)),
    ...overrides,
  } as unknown as MigrationOrchestrator;
}

function makeNodeRepo(): INodeRepository {
  return {
    getById: vi.fn(),
    list: vi.fn(),
    register: vi.fn(),
    transition: vi.fn().mockResolvedValue({ id: NODE_ID, status: "draining" }),
    updateHeartbeat: vi.fn(),
    addCapacity: vi.fn(),
    findBestTarget: vi.fn(),
    listTransitions: vi.fn(),
  } as unknown as INodeRepository;
}

function makeBotInstanceRepo(instances: (typeof defaultInstance1)[] = []): IBotInstanceRepository {
  return {
    getById: vi.fn(),
    listByNode: vi.fn().mockResolvedValue(instances),
    listByTenant: vi.fn(),
    create: vi.fn(),
    reassign: vi.fn(),
    setBillingState: vi.fn(),
  } as unknown as IBotInstanceRepository;
}

function makeNotifier(): AdminNotifier {
  return {
    nodeRecoveryComplete: vi.fn().mockResolvedValue(undefined),
    nodeStatusChange: vi.fn().mockResolvedValue(undefined),
    capacityOverflow: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdminNotifier;
}

describe("NodeDrainer", () => {
  let migrationOrch: MigrationOrchestrator;
  let nodeRepo: INodeRepository;
  let botInstanceRepo: IBotInstanceRepository;
  let notifier: AdminNotifier;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("drain — happy path (all migrations succeed)", () => {
    it("transitions node to draining, migrates all tenants, transitions to offline", async () => {
      migrationOrch = makeMigrationOrchestrator({
        migrate: vi.fn().mockResolvedValueOnce(successResult(BOT_1)).mockResolvedValueOnce(successResult(BOT_2)),
      });
      nodeRepo = makeNodeRepo();
      botInstanceRepo = makeBotInstanceRepo([defaultInstance1, defaultInstance2]);
      notifier = makeNotifier();

      const drainer = new NodeDrainer(migrationOrch, nodeRepo, botInstanceRepo, notifier);
      const result = await drainer.drain(NODE_ID);

      // 1. Node transitioned to "draining" first
      expect(nodeRepo.transition).toHaveBeenCalledWith(NODE_ID, "draining", "node_drain", "migration_orchestrator");

      // 2. Both tenants migrated
      expect(migrationOrch.migrate).toHaveBeenCalledTimes(2);
      expect(migrationOrch.migrate).toHaveBeenCalledWith(BOT_1, undefined, 100);
      expect(migrationOrch.migrate).toHaveBeenCalledWith(BOT_2, undefined, 100);

      // 3. Node transitioned to "offline" after full success
      expect(nodeRepo.transition).toHaveBeenCalledWith(NODE_ID, "offline", "drain_complete", "migration_orchestrator");

      // 4. No admin notification (no failures)
      expect(notifier.capacityOverflow).not.toHaveBeenCalled();

      // 5. Result
      expect(result.nodeId).toBe(NODE_ID);
      expect(result.migrated).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
    });
  });

  describe("drain — no in-flight tenants (idle node)", () => {
    it("completes immediately and transitions to offline", async () => {
      migrationOrch = makeMigrationOrchestrator();
      nodeRepo = makeNodeRepo();
      botInstanceRepo = makeBotInstanceRepo([]); // no tenants
      notifier = makeNotifier();

      const drainer = new NodeDrainer(migrationOrch, nodeRepo, botInstanceRepo, notifier);
      const result = await drainer.drain(NODE_ID);

      // Transitions to draining then immediately to offline
      expect(nodeRepo.transition).toHaveBeenCalledTimes(2);
      expect(nodeRepo.transition).toHaveBeenNthCalledWith(
        1,
        NODE_ID,
        "draining",
        "node_drain",
        "migration_orchestrator",
      );
      expect(nodeRepo.transition).toHaveBeenNthCalledWith(
        2,
        NODE_ID,
        "offline",
        "drain_complete",
        "migration_orchestrator",
      );

      // No migrations attempted
      expect(migrationOrch.migrate).not.toHaveBeenCalled();

      // No notification
      expect(notifier.capacityOverflow).not.toHaveBeenCalled();

      expect(result.migrated).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });
  });

  describe("drain — partial failure", () => {
    it("does NOT transition to offline and notifies admin", async () => {
      migrationOrch = makeMigrationOrchestrator({
        migrate: vi.fn().mockResolvedValueOnce(successResult(BOT_1)).mockResolvedValueOnce(failureResult(BOT_2)),
      });
      nodeRepo = makeNodeRepo();
      botInstanceRepo = makeBotInstanceRepo([defaultInstance1, defaultInstance2]);
      notifier = makeNotifier();

      const drainer = new NodeDrainer(migrationOrch, nodeRepo, botInstanceRepo, notifier);
      const result = await drainer.drain(NODE_ID);

      // Node transitions to "draining" but NOT "offline"
      expect(nodeRepo.transition).toHaveBeenCalledTimes(1);
      expect(nodeRepo.transition).toHaveBeenCalledWith(NODE_ID, "draining", "node_drain", "migration_orchestrator");

      // Admin notified with failed count and total count
      expect(notifier.capacityOverflow).toHaveBeenCalledWith(NODE_ID, 1, 2);

      expect(result.migrated).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].botId).toBe(BOT_2);
    });
  });

  describe("drain — all migrations fail", () => {
    it("stays in draining state and notifies admin with full count", async () => {
      migrationOrch = makeMigrationOrchestrator({
        migrate: vi.fn().mockResolvedValueOnce(failureResult(BOT_1)).mockResolvedValueOnce(failureResult(BOT_2)),
      });
      nodeRepo = makeNodeRepo();
      botInstanceRepo = makeBotInstanceRepo([defaultInstance1, defaultInstance2]);
      notifier = makeNotifier();

      const drainer = new NodeDrainer(migrationOrch, nodeRepo, botInstanceRepo, notifier);
      const result = await drainer.drain(NODE_ID);

      // Only the draining transition, no offline
      expect(nodeRepo.transition).toHaveBeenCalledTimes(1);

      // Admin notified: 2 failed out of 2 total
      expect(notifier.capacityOverflow).toHaveBeenCalledWith(NODE_ID, 2, 2);

      expect(result.migrated).toHaveLength(0);
      expect(result.failed).toHaveLength(2);
    });
  });

  describe("drain — status transition order", () => {
    it("transitions to draining BEFORE any migration starts", async () => {
      const callOrder: string[] = [];

      const nodeRepoMock = makeNodeRepo();
      (nodeRepoMock.transition as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push("transition");
        return { id: NODE_ID, status: "draining" };
      });

      const migrationOrchMock = makeMigrationOrchestrator({
        migrate: vi.fn().mockImplementation(async (botId: string) => {
          callOrder.push(`migrate-${botId}`);
          return successResult(botId);
        }),
      });

      botInstanceRepo = makeBotInstanceRepo([defaultInstance1]);
      notifier = makeNotifier();

      const drainer = new NodeDrainer(migrationOrchMock, nodeRepoMock, botInstanceRepo, notifier);
      await drainer.drain(NODE_ID);

      // First call must be the draining transition, then migration, then offline transition
      expect(callOrder[0]).toBe("transition");
      expect(callOrder[1]).toBe(`migrate-${BOT_1}`);
    });
  });
});
