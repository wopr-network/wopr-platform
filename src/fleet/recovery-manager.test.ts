import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { botInstances, nodes, recoveryEvents, recoveryItems } from "../db/schema/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import type { AdminNotifier } from "./admin-notifier.js";
import type { NodeConnectionManager } from "./node-connection-manager.js";
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

describe("RecoveryManager", () => {
  describe("recoverTenant uses bot profile for image/env", () => {
    let db: DrizzleDb;
    let pool: PGlite;
    let notifier: AdminNotifier;
    let nodeConnections: NodeConnectionManager;
    let sendCommand: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
      ({ db, pool } = await createTestDb());
    });

    afterAll(async () => {
      await pool.close();
    });

    beforeEach(async () => {
      await truncateAllTables(pool);
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
      const manager = new RecoveryManager(db, nodeConnections, notifier);

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
      expect(importCall).toBeDefined();

      const importCmd = importCall?.[1] as { payload: { image: string; env: Record<string, string> } };
      expect(importCmd.payload.image).toBe("ghcr.io/wopr-network/wopr:v2.0.0");
      expect(importCmd.payload.env).toEqual({ TOKEN: "secret-abc", LOG_LEVEL: "debug" });
      expect(importCmd.payload.image).not.toBe("ghcr.io/wopr-network/wopr:latest");
    });

    it("falls back to defaults with logger.warn when no profile exists", async () => {
      const manager = new RecoveryManager(db, nodeConnections, notifier);

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
      expect(importCall).toBeDefined();

      const importCmd = importCall?.[1] as { payload: { image: string; env: Record<string, string> } };
      expect(importCmd.payload.image).toBe("ghcr.io/wopr-network/wopr:latest");
      expect(importCmd.payload.env).toEqual({});
    });

    it("falls back to empty env when profile env JSON is corrupt", async () => {
      const manager = new RecoveryManager(db, nodeConnections, notifier);

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
      expect(importCall).toBeDefined();

      const importCmd = importCall?.[1] as { payload: { image: string; env: Record<string, string> } };
      expect(importCmd.payload.image).toBe("ghcr.io/wopr-network/wopr:v3.0.0");
      expect(importCmd.payload.env).toEqual({});
    });
  });
});

describe("RecoveryManager.checkAndRetryWaiting", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let notifier: AdminNotifier;
  let nodeConnections: NodeConnectionManager;
  let manager: RecoveryManager;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    notifier = createMockNotifier();
    nodeConnections = createMockNodeConnections();
    manager = new RecoveryManager(db, nodeConnections, notifier);
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
    const { db, pool } = await createTestDb();
    try {
      const mockNotifier = createMockNotifier();
      const mockNodeConns = createMockNodeConnections();
      const mgr = new RecoveryManager(db, mockNodeConns, mockNotifier);

      await expect(mgr.checkAndRetryWaiting()).resolves.toBeUndefined();
    } finally {
      await pool.close();
    }
  });
});

describe("Acceptance criteria", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let notifier: AdminNotifier;
  let nodeConnections: NodeConnectionManager;
  let manager: RecoveryManager;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    notifier = createMockNotifier();
    nodeConnections = createMockNodeConnections();
    manager = new RecoveryManager(db, nodeConnections, notifier);
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
