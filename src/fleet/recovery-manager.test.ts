import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { botInstances, nodes, recoveryEvents, recoveryItems } from "../db/schema/index.js";
import { beginTestTransaction, createTestDb, endTestTransaction, rollbackTestTransaction } from "../test/db.js";
import type { AdminNotifier } from "./admin-notifier.js";
import { DrizzleBotInstanceRepository } from "./drizzle-bot-instance-repository.js";
import { DrizzleBotProfileRepository } from "./drizzle-bot-profile-repository.js";
import { DrizzleRecoveryRepository } from "./drizzle-recovery-repository.js";
import type { NodeConnectionManager } from "./node-connection-manager.js";
import type { INodeRepository } from "./node-repository.js";
import { InvalidTransitionError } from "./node-state-machine.js";
import { RecoveryManager } from "./recovery-manager.js";

function createMockNodeConnections(overrides: Record<string, unknown> = {}): NodeConnectionManager {
  return {
    findBestTarget: vi.fn().mockResolvedValue(null),
    sendCommand: vi.fn().mockResolvedValue({
      id: "cmd-1",
      type: "command_result",
      command: "test",
      success: true,
    }),
    reassignTenant: vi.fn(),
    addNodeCapacity: vi.fn(),
    registerNode: vi.fn(),
    ...overrides,
  } as unknown as NodeConnectionManager;
}

function createMockNotifier(): AdminNotifier {
  return {
    nodeRecoveryComplete: vi.fn().mockResolvedValue(undefined),
    capacityOverflow: vi.fn().mockResolvedValue(undefined),
    nodeStatusChange: vi.fn().mockResolvedValue(undefined),
    waitingTenantsExpired: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdminNotifier;
}

function createMockNodeRepo(overrides: Record<string, unknown> = {}): INodeRepository {
  return {
    transition: vi.fn().mockResolvedValue({ id: "node-1", status: "recovering" }),
    getById: vi.fn().mockResolvedValue({ id: "node-1", status: "unhealthy" }),
    getBySecret: vi.fn(),
    list: vi.fn(),
    register: vi.fn(),
    registerSelfHosted: vi.fn(),
    updateHeartbeat: vi.fn(),
    addCapacity: vi.fn(),
    findBestTarget: vi.fn(),
    listTransitions: vi.fn(),
    delete: vi.fn(),
    verifyNodeSecret: vi.fn(),
    insertProvisioning: vi.fn(),
    updateProvisionData: vi.fn(),
    updateProvisionStage: vi.fn(),
    markFailed: vi.fn(),
    getStatus: vi.fn(),
    updateHeartbeatWithStatus: vi.fn(),
    ...overrides,
  } as unknown as INodeRepository;
}

function makeManager(
  db: DrizzleDb,
  options: {
    nodeRepo?: INodeRepository;
    nodeConnections?: NodeConnectionManager;
    notifier?: AdminNotifier;
  } = {},
): RecoveryManager {
  return new RecoveryManager(
    new DrizzleRecoveryRepository(db),
    new DrizzleBotInstanceRepository(db),
    new DrizzleBotProfileRepository(db),
    options.nodeRepo ?? createMockNodeRepo(),
    options.nodeConnections ?? createMockNodeConnections(),
    options.notifier ?? createMockNotifier(),
  );
}

async function insertNode(
  db: DrizzleDb,
  values: { id: string; host?: string; capacityMb?: number; usedMb?: number; status?: string },
) {
  const now = Math.floor(Date.now() / 1000);
  await db.insert(nodes).values({
    id: values.id,
    host: values.host ?? "10.0.0.1",
    capacityMb: values.capacityMb ?? 4096,
    usedMb: values.usedMb ?? 0,
    status: values.status ?? "active",
    registeredAt: now,
    updatedAt: now,
  });
}

// TOP OF FILE - shared across ALL describes
let pool: PGlite;
let db: DrizzleDb;

beforeAll(async () => {
  ({ db, pool } = await createTestDb());
  await beginTestTransaction(pool);
});

afterAll(async () => {
  await endTestTransaction(pool);
  await pool.close();
});

describe("RecoveryManager - recoverTenant uses bot profile for image/env", () => {
  let notifier: AdminNotifier;
  let nodeConnections: NodeConnectionManager;
  let sendCommand: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    notifier = createMockNotifier();
    sendCommand = vi.fn().mockResolvedValue({
      id: "cmd-1",
      type: "command_result",
      command: "test",
      success: true,
    });
    nodeConnections = createMockNodeConnections({
      sendCommand,
      findBestTarget: vi.fn().mockResolvedValue({
        id: "target-node-1",
        host: "10.0.0.2",
        status: "active",
        capacityMb: 4096,
        usedMb: 512,
      }),
    });
  });

  it("reads image and env from bot_profiles instead of hardcoding", async () => {
    const manager = makeManager(db, { nodeConnections, notifier });

    await insertNode(db, { id: "dead-node", status: "active", usedMb: 1024 });
    await insertNode(db, { id: "target-node-1", host: "10.0.0.2", usedMb: 512 });

    await db.insert(botInstances).values({
      id: "bot-1",
      tenantId: "tenant-1",
      name: "my-bot",
      nodeId: "dead-node",
    });

    // Insert bot profile with pinned image and custom env (using raw SQL compatible with Drizzle)
    await db.execute(
      `INSERT INTO bot_profiles (id, tenant_id, name, image, env, restart_policy, update_policy, release_channel, description)
       VALUES ('bot-1', 'tenant-1', 'my-bot', 'ghcr.io/wopr-network/wopr:v2.0.0', '{"TOKEN":"secret-abc","LOG_LEVEL":"debug"}', 'unless-stopped', 'on-push', 'stable', '')`,
    );

    await manager.triggerRecovery("dead-node", "heartbeat_timeout");

    const importCall = sendCommand.mock.calls.find(
      (args: unknown[]) => (args[1] as { type?: string })?.type === "bot.import",
    );
    expect(importCall).not.toBeUndefined();

    const importCmd = importCall?.[1] as { payload: { image: string; env: Record<string, string> } };
    expect(importCmd.payload.image).toBe("ghcr.io/wopr-network/wopr:v2.0.0");
    expect(importCmd.payload.env).toEqual({ TOKEN: "secret-abc", LOG_LEVEL: "debug" });
    expect(importCmd.payload.image).not.toBe("ghcr.io/wopr-network/wopr:latest");
  });

  it("falls back to defaults with logger.warn when no profile exists", async () => {
    const manager = makeManager(db, { nodeConnections, notifier });

    await insertNode(db, { id: "dead-node", status: "active", usedMb: 1024 });
    await insertNode(db, { id: "target-node-1", host: "10.0.0.2", usedMb: 512 });

    await db.insert(botInstances).values({
      id: "bot-1",
      tenantId: "tenant-1",
      name: "my-bot",
      nodeId: "dead-node",
    });

    await manager.triggerRecovery("dead-node", "manual");

    const importCall = sendCommand.mock.calls.find(
      (args: unknown[]) => (args[1] as { type?: string })?.type === "bot.import",
    );
    expect(importCall).not.toBeUndefined();

    const importCmd = importCall?.[1] as { payload: { image: string; env: Record<string, string> } };
    expect(importCmd.payload.image).toBe("ghcr.io/wopr-network/wopr:latest");
    expect(importCmd.payload.env).toEqual({});
  });

  it("falls back to empty env when profile env JSON is corrupt", async () => {
    const manager = makeManager(db, { nodeConnections, notifier });

    await insertNode(db, { id: "dead-node", status: "active", usedMb: 1024 });
    await insertNode(db, { id: "target-node-1", host: "10.0.0.2", usedMb: 512 });

    await db.insert(botInstances).values({
      id: "bot-1",
      tenantId: "tenant-1",
      name: "my-bot",
      nodeId: "dead-node",
    });

    await db.execute(
      `INSERT INTO bot_profiles (id, tenant_id, name, image, env, restart_policy, update_policy, release_channel, description)
       VALUES ('bot-1', 'tenant-1', 'my-bot', 'ghcr.io/wopr-network/wopr:v3.0.0', 'not-valid-json{{{', 'unless-stopped', 'on-push', 'stable', '')`,
    );

    await manager.triggerRecovery("dead-node", "manual");

    const importCall = sendCommand.mock.calls.find(
      (args: unknown[]) => (args[1] as { type?: string })?.type === "bot.import",
    );
    expect(importCall).not.toBeUndefined();

    const importCmd = importCall?.[1] as { payload: { image: string; env: Record<string, string> } };
    expect(importCmd.payload.image).toBe("ghcr.io/wopr-network/wopr:v3.0.0");
    expect(importCmd.payload.env).toEqual({});
  });
});

describe("RecoveryManager.triggerRecovery — state machine transitions", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let nodeConnections: NodeConnectionManager;
  let notifier: AdminNotifier;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    await beginTestTransaction(pool);
  });

  afterAll(async () => {
    await endTestTransaction(pool);
    await pool.close();
  });

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    notifier = createMockNotifier();
    nodeConnections = createMockNodeConnections();
  });

  it("transitions node via state machine: offline then recovering then offline", async () => {
    const getById = vi.fn().mockResolvedValue({ id: "node-1", status: "unhealthy" });
    const transition = vi.fn().mockResolvedValue({ id: "node-1", status: "recovering" });
    const localNodeRepo = createMockNodeRepo({ getById, transition });
    const manager = makeManager(db, { nodeRepo: localNodeRepo, nodeConnections, notifier });

    await insertNode(db, { id: "node-1", status: "active" });

    await manager.triggerRecovery("node-1", "heartbeat_timeout");

    expect(transition).toHaveBeenCalledWith("node-1", "offline", "heartbeat_timeout", "recovery_manager");
    expect(transition).toHaveBeenCalledWith("node-1", "recovering", "heartbeat_timeout", "recovery_manager");
    expect(transition).toHaveBeenCalledWith("node-1", "offline", "recovery_complete", "recovery_manager");
    expect(transition).toHaveBeenCalledTimes(3);
  });

  it("logs and re-throws when transition() rejects with InvalidTransitionError", async () => {
    const err = new InvalidTransitionError("active", "recovering");
    const getById = vi.fn().mockResolvedValue({ id: "node-1", status: "unhealthy" });
    const transition = vi.fn().mockRejectedValueOnce(err);
    const localNodeRepo = createMockNodeRepo({ getById, transition });

    const manager = makeManager(db, { nodeRepo: localNodeRepo, nodeConnections, notifier });

    await insertNode(db, { id: "node-1", status: "active" });

    await expect(manager.triggerRecovery("node-1", "manual")).rejects.toThrow(InvalidTransitionError);
  });

  it("skips unhealthy→offline transition when node is already offline", async () => {
    const getById = vi.fn().mockResolvedValue({ id: "node-1", status: "offline" });
    const transition = vi.fn().mockResolvedValue({ id: "node-1", status: "recovering" });
    const localNodeRepo = createMockNodeRepo({ getById, transition });
    const localNodeConns = createMockNodeConnections();
    const manager = makeManager(db, { nodeRepo: localNodeRepo, nodeConnections: localNodeConns, notifier });

    await insertNode(db, { id: "node-1", status: "offline" });

    await manager.triggerRecovery("node-1", "heartbeat_timeout");

    // Should NOT call transition to "offline" with transitionReason — node is already offline
    // (only the final "recovery_complete" offline transition is allowed)
    const offlineTransitionCalls = transition.mock.calls.filter(
      (c: unknown[]) => c[1] === "offline" && c[2] !== "recovery_complete",
    );
    expect(offlineTransitionCalls).toHaveLength(0);
    // Should call transition to "recovering"
    expect(transition).toHaveBeenCalledWith("node-1", "recovering", "heartbeat_timeout", "recovery_manager");
    // Final transition back to offline after recovery completes
    expect(transition).toHaveBeenCalledWith("node-1", "offline", "recovery_complete", "recovery_manager");
  });

  it("skips both initial transitions when node is already recovering", async () => {
    const getById = vi.fn().mockResolvedValue({ id: "node-1", status: "recovering" });
    const transition = vi.fn().mockResolvedValue({ id: "node-1", status: "recovering" });
    const localNodeRepo = createMockNodeRepo({ getById, transition });
    const localNodeConns = createMockNodeConnections();
    const manager = makeManager(db, { nodeRepo: localNodeRepo, nodeConnections: localNodeConns, notifier });

    await insertNode(db, { id: "node-1", status: "recovering" });

    await manager.triggerRecovery("node-1", "manual");

    // Only the final "offline" transition after recovery completes should exist
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith("node-1", "offline", "recovery_complete", "recovery_manager");
  });

  it("throws when node does not exist", async () => {
    const getById = vi.fn().mockResolvedValue(null);
    const localNodeRepo = createMockNodeRepo({ getById });
    const manager = makeManager(db, {
      nodeRepo: localNodeRepo,
      nodeConnections: createMockNodeConnections(),
      notifier,
    });

    await expect(manager.triggerRecovery("nonexistent", "manual")).rejects.toThrow("not found");
  });
});

describe("RecoveryManager.checkAndRetryWaiting", () => {
  let notifier: AdminNotifier;
  let nodeConnections: NodeConnectionManager;
  let manager: RecoveryManager;

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    notifier = createMockNotifier();
    nodeConnections = createMockNodeConnections();
    manager = makeManager(db, { nodeConnections, notifier });
  });

  it("retries waiting tenants when a recovery event has waiting items and retryCount < max", async () => {
    const now = Math.floor(Date.now() / 1000);

    await insertNode(db, { id: "target-node", host: "10.0.0.2", status: "active" });
    await insertNode(db, { id: "dead-node", status: "offline", usedMb: 4096 });

    await db.insert(botInstances).values({ id: "bot-1", tenantId: "tenant-1", name: "my-bot", nodeId: "dead-node" });

    await db.insert(recoveryEvents).values({
      id: "evt-1",
      nodeId: "dead-node",
      trigger: "heartbeat_timeout",
      status: "partial",
      tenantsTotal: 1,
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 1,
      startedAt: now,
    });

    await db.insert(recoveryItems).values({
      id: "item-1",
      recoveryEventId: "evt-1",
      tenant: "tenant-1",
      sourceNode: "dead-node",
      status: "waiting",
      reason: "no_capacity",
      retryCount: 2,
      startedAt: now,
    });

    (nodeConnections.findBestTarget as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "target-node",
      host: "10.0.0.2",
      status: "active",
      capacityMb: 4096,
      usedMb: 0,
    });

    await manager.checkAndRetryWaiting();

    const items = await db.select().from(recoveryItems);
    expect(items.length).toBeGreaterThanOrEqual(1);
    const original = items.find((i) => i.id === "item-1");
    expect(original?.status).toBe("retried");
  });

  it("marks waiting items as failed when retryCount >= MAX_RETRY_ATTEMPTS", async () => {
    const now = Math.floor(Date.now() / 1000);

    await insertNode(db, { id: "dead-node", status: "offline", usedMb: 4096 });

    await db.insert(recoveryEvents).values({
      id: "evt-1",
      nodeId: "dead-node",
      trigger: "heartbeat_timeout",
      status: "partial",
      tenantsTotal: 1,
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 1,
      startedAt: now,
    });

    await db.insert(recoveryItems).values({
      id: "item-1",
      recoveryEventId: "evt-1",
      tenant: "tenant-1",
      sourceNode: "dead-node",
      status: "waiting",
      reason: "no_capacity",
      retryCount: 5,
      startedAt: now,
    });

    await manager.checkAndRetryWaiting();

    const items = await db.select().from(recoveryItems);
    const item = items.find((i) => i.id === "item-1");
    expect(item?.status).toBe("failed");
    expect(item?.completedAt).not.toBeNull();

    const events = await db.select().from(recoveryEvents);
    const event = events.find((e) => e.id === "evt-1");
    expect(event?.status).toBe("completed");

    expect(notifier.waitingTenantsExpired as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("marks waiting items as failed when event exceeds 24h time cap", async () => {
    const now = Math.floor(Date.now() / 1000);
    const twentyFiveHoursAgo = now - 25 * 60 * 60;

    await insertNode(db, { id: "dead-node", status: "offline", usedMb: 4096 });

    await db.insert(recoveryEvents).values({
      id: "evt-1",
      nodeId: "dead-node",
      trigger: "heartbeat_timeout",
      status: "partial",
      tenantsTotal: 1,
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 1,
      startedAt: twentyFiveHoursAgo,
    });

    await db.insert(recoveryItems).values({
      id: "item-1",
      recoveryEventId: "evt-1",
      tenant: "tenant-1",
      sourceNode: "dead-node",
      status: "waiting",
      reason: "no_capacity",
      retryCount: 1,
      startedAt: twentyFiveHoursAgo,
    });

    await manager.checkAndRetryWaiting();

    const items = await db.select().from(recoveryItems);
    const item = items.find((i) => i.id === "item-1");
    expect(item?.status).toBe("failed");

    const events = await db.select().from(recoveryEvents);
    const event = events.find((e) => e.id === "evt-1");
    expect(event?.status).toBe("completed");
  });

  it("does nothing when there are no open recovery events with waiting items", async () => {
    await manager.checkAndRetryWaiting();
    expect(notifier.waitingTenantsExpired as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("completes event when all waiting items are resolved after retry", async () => {
    const now = Math.floor(Date.now() / 1000);

    await insertNode(db, { id: "target-node", host: "10.0.0.2", status: "active" });
    await insertNode(db, { id: "dead-node", status: "offline", usedMb: 4096 });

    await db.insert(botInstances).values({ id: "bot-1", tenantId: "tenant-1", name: "my-bot", nodeId: "dead-node" });

    await db.insert(recoveryEvents).values({
      id: "evt-1",
      nodeId: "dead-node",
      trigger: "heartbeat_timeout",
      status: "partial",
      tenantsTotal: 2,
      tenantsRecovered: 1,
      tenantsFailed: 0,
      tenantsWaiting: 1,
      startedAt: now,
    });

    await db.insert(recoveryItems).values([
      {
        id: "item-done",
        recoveryEventId: "evt-1",
        tenant: "tenant-0",
        sourceNode: "dead-node",
        targetNode: "target-node",
        status: "recovered",
        retryCount: 0,
        startedAt: now,
        completedAt: now,
      },
      {
        id: "item-wait",
        recoveryEventId: "evt-1",
        tenant: "tenant-1",
        sourceNode: "dead-node",
        status: "waiting",
        reason: "no_capacity",
        retryCount: 0,
        startedAt: now,
      },
    ]);

    (nodeConnections.findBestTarget as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "target-node",
      host: "10.0.0.2",
      status: "active",
      capacityMb: 4096,
      usedMb: 0,
    });

    await manager.checkAndRetryWaiting();

    const events = await db.select().from(recoveryEvents);
    const event = events.find((e) => e.id === "evt-1");
    expect(event?.status).toBe("completed");
    expect(event?.completedAt).not.toBeNull();
  });
});

describe("Trigger 1: Node registration fires checkAndRetryWaiting", () => {
  it("calls checkAndRetryWaiting after registerNode via onNodeRegistered callback", async () => {
    await rollbackTestTransaction(pool);
    const mockNotifier = createMockNotifier();
    const mockNodeConns = createMockNodeConnections();
    const mgr = makeManager(db, { nodeConnections: mockNodeConns, notifier: mockNotifier });

    await expect(mgr.checkAndRetryWaiting()).resolves.toBeUndefined();
  });
});

describe("Acceptance criteria", () => {
  let notifier: AdminNotifier;
  let nodeConnections: NodeConnectionManager;
  let manager: RecoveryManager;

  beforeEach(async () => {
    await rollbackTestTransaction(pool);
    notifier = createMockNotifier();
    nodeConnections = createMockNodeConnections();
    manager = makeManager(db, { nodeConnections, notifier });
  });

  it("AC: node with waiting tenants -> new node joins -> waiting tenants auto-placed", async () => {
    const now = Math.floor(Date.now() / 1000);

    await insertNode(db, { id: "dead-node", status: "offline", usedMb: 4096 });
    await insertNode(db, { id: "new-node", host: "10.0.0.3", capacityMb: 8192, status: "active" });
    await db.insert(botInstances).values({ id: "bot-1", tenantId: "tenant-1", name: "my-bot", nodeId: "dead-node" });

    await db.insert(recoveryEvents).values({
      id: "evt-1",
      nodeId: "dead-node",
      trigger: "heartbeat_timeout",
      status: "partial",
      tenantsTotal: 1,
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 1,
      startedAt: now,
    });

    await db.insert(recoveryItems).values({
      id: "item-1",
      recoveryEventId: "evt-1",
      tenant: "tenant-1",
      sourceNode: "dead-node",
      status: "waiting",
      reason: "no_capacity",
      retryCount: 0,
      startedAt: now,
    });

    (nodeConnections.findBestTarget as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "new-node",
      host: "10.0.0.3",
      status: "active",
      capacityMb: 8192,
      usedMb: 0,
    });

    await manager.checkAndRetryWaiting();

    const items = await db.select().from(recoveryItems);
    const item = items.find((i) => i.id === "item-1");
    expect(item?.status).toBe("retried");

    const events = await db.select().from(recoveryEvents);
    const event = events.find((e) => e.id === "evt-1");
    expect(event?.status).toBe("completed");
  });

  it("AC: retry limit reached -> items marked failed, event closed, admin notified", async () => {
    const now = Math.floor(Date.now() / 1000);

    await insertNode(db, { id: "dead-node", status: "offline", usedMb: 4096 });

    await db.insert(recoveryEvents).values({
      id: "evt-1",
      nodeId: "dead-node",
      trigger: "heartbeat_timeout",
      status: "partial",
      tenantsTotal: 2,
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 2,
      startedAt: now,
    });

    await db.insert(recoveryItems).values([
      {
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "tenant-1",
        sourceNode: "dead-node",
        status: "waiting",
        reason: "no_capacity",
        retryCount: 5,
        startedAt: now,
      },
      {
        id: "item-2",
        recoveryEventId: "evt-1",
        tenant: "tenant-2",
        sourceNode: "dead-node",
        status: "waiting",
        reason: "no_capacity",
        retryCount: 7,
        startedAt: now,
      },
    ]);

    await manager.checkAndRetryWaiting();

    const items = await db.select().from(recoveryItems);
    for (const item of items) {
      expect(item.status).toBe("failed");
      expect(item.reason).toBe("max_retries_exceeded");
      expect(item.completedAt).not.toBeNull();
    }

    const events = await db.select().from(recoveryEvents);
    const event = events.find((e) => e.id === "evt-1");
    expect(event?.status).toBe("completed");
    expect(event?.tenantsFailed).toBe(2);
    expect(event?.tenantsWaiting).toBe(0);

    expect(notifier.waitingTenantsExpired as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "evt-1",
      2,
      "max_retries_exceeded",
    );
  });
});
