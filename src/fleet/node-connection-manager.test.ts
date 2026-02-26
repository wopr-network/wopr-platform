import { EventEmitter } from "node:events";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { botInstances, nodes, recoveryEvents } from "../db/schema/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { NodeConnectionManager } from "./node-connection-manager.js";
import type { OrphanCleaner } from "./orphan-cleaner.js";
import { findPlacement } from "./placement.js";

function makeOrphanCleaner(overrides: Partial<OrphanCleaner> = {}): OrphanCleaner {
  return {
    clean: vi.fn().mockResolvedValue({
      nodeId: "node-1",
      stopped: [],
      kept: [],
      errors: [],
    }),
    ...overrides,
  } as unknown as OrphanCleaner;
}

async function insertNode(
  db: DrizzleDb,
  values: { id: string; host?: string; capacityMb?: number; usedMb?: number; status?: string },
) {
  await db.insert(nodes).values({
    id: values.id,
    host: values.host ?? "10.0.0.1",
    capacityMb: values.capacityMb ?? 8192,
    usedMb: values.usedMb ?? 0,
    status: values.status ?? "active",
    registeredAt: 1000,
    updatedAt: 1000,
  });
}

describe("NodeConnectionManager.registerNode", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ncm: NodeConnectionManager;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    ncm = new NodeConnectionManager(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("sets status to active for a brand-new node", async () => {
    await ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const rows = await db.select().from(nodes).where(eq(nodes.id, "node-1"));
    const node = rows[0];
    expect(node).toBeDefined();
    expect(node?.status).toBe("active");
  });

  it("sets status to returning for a node that was offline", async () => {
    await insertNode(db, { id: "node-1", status: "offline" });

    await ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const rows = await db.select().from(nodes).where(eq(nodes.id, "node-1"));
    expect(rows[0]?.status).toBe("returning");
  });

  it("sets status to returning for a node that was recovering", async () => {
    await insertNode(db, { id: "node-1", status: "recovering" });

    await ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const rows = await db.select().from(nodes).where(eq(nodes.id, "node-1"));
    expect(rows[0]?.status).toBe("returning");
  });

  it("sets status to returning for a node that was failed", async () => {
    await insertNode(db, { id: "node-1", status: "failed" });

    await ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const rows = await db.select().from(nodes).where(eq(nodes.id, "node-1"));
    expect(rows[0]?.status).toBe("returning");
  });

  it("re-registers an active node as still active (no regression)", async () => {
    await insertNode(db, { id: "node-1", status: "active" });

    await ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.2",
      capacity_mb: 16384,
      agent_version: "2.0.0",
    });

    const rows = await db.select().from(nodes).where(eq(nodes.id, "node-1"));
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.host).toBe("10.0.0.2");
    expect(rows[0]?.capacityMb).toBe(16384);
  });

  it("re-registers an unhealthy node as active (heartbeat recovery)", async () => {
    await insertNode(db, { id: "node-1", status: "unhealthy" });

    await ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const rows = await db.select().from(nodes).where(eq(nodes.id, "node-1"));
    expect(rows[0]?.status).toBe("active");
  });

  it("closes in-flight recovery events for the returning node", async () => {
    await insertNode(db, { id: "node-1", status: "offline" });

    await db.insert(recoveryEvents).values({
      id: "evt-1",
      nodeId: "node-1",
      trigger: "heartbeat_timeout",
      status: "in_progress",
      tenantsTotal: 3,
      tenantsRecovered: 1,
      tenantsFailed: 0,
      tenantsWaiting: 2,
      startedAt: 900,
      completedAt: null,
    });

    await ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const evtRows = await db.select().from(recoveryEvents).where(eq(recoveryEvents.id, "evt-1"));
    expect(evtRows[0]?.status).toBe("completed");
    expect(evtRows[0]?.completedAt).toBeDefined();
    expect(evtRows[0]?.completedAt).not.toBeNull();
  });
});

describe("NodeConnectionManager.processHeartbeat — returning status preservation", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ncm: NodeConnectionManager;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    ncm = new NodeConnectionManager(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("does not override returning status to active on heartbeat", async () => {
    await insertNode(db, { id: "node-1", status: "returning" });

    const fakeWs = Object.assign(new EventEmitter(), { readyState: 1 });
    ncm.handleWebSocket("node-1", fakeWs as unknown as import("ws").WebSocket);

    const heartbeat = Buffer.from(JSON.stringify({ type: "heartbeat", containers: [] }));
    fakeWs.emit("message", heartbeat);

    // Give async processing a tick
    await new Promise((resolve) => setTimeout(resolve, 10));

    const rows = await db.select().from(nodes).where(eq(nodes.id, "node-1"));
    expect(rows[0]?.status).toBe("returning");
  });
});

describe("NodeConnectionManager heartbeat triggers OrphanCleaner for returning nodes", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ncm: NodeConnectionManager;
  let orphanCleaner: OrphanCleaner;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    orphanCleaner = makeOrphanCleaner();
    ncm = new NodeConnectionManager(db);
    ncm.setOrphanCleaner(orphanCleaner);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    vi.clearAllMocks();
  });

  it("triggers OrphanCleaner.clean on first heartbeat from a returning node", async () => {
    await insertNode(db, { id: "node-1", status: "returning" });

    const heartbeatMsg = Buffer.from(
      JSON.stringify({
        type: "heartbeat",
        containers: [
          { name: "tenant_orphan", memory_mb: 100 },
          { name: "tenant_legit", memory_mb: 200 },
        ],
      }),
    );

    const mockWs = {
      readyState: 1,
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    };

    ncm.handleWebSocket("node-1", mockWs as never);

    const messageHandler = (mockWs.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "message",
    )?.[1];

    expect(messageHandler).toBeDefined();

    messageHandler(heartbeatMsg);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(orphanCleaner.clean).toHaveBeenCalledWith({
      nodeId: "node-1",
      runningContainers: ["tenant_orphan", "tenant_legit"],
    });
  });

  it("does NOT trigger OrphanCleaner for active nodes", async () => {
    await insertNode(db, { id: "node-1", status: "active" });

    const heartbeatMsg = Buffer.from(
      JSON.stringify({
        type: "heartbeat",
        containers: [{ name: "tenant_abc", memory_mb: 100 }],
      }),
    );

    const mockWs = {
      readyState: 1,
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    };

    ncm.handleWebSocket("node-1", mockWs as never);

    const messageHandler = (mockWs.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "message",
    )?.[1];

    messageHandler(heartbeatMsg);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(orphanCleaner.clean).not.toHaveBeenCalled();
  });

  it("does NOT trigger OrphanCleaner twice for same returning episode", async () => {
    await insertNode(db, { id: "node-1", status: "returning" });

    const cleanMock = vi.fn().mockImplementation(async () => {
      await db.update(nodes).set({ status: "active" }).where(eq(nodes.id, "node-1"));
      return { nodeId: "node-1", stopped: [], kept: [], errors: [] };
    });
    orphanCleaner = makeOrphanCleaner({ clean: cleanMock });
    ncm = new NodeConnectionManager(db);
    ncm.setOrphanCleaner(orphanCleaner);

    const mockWs = {
      readyState: 1,
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    };

    ncm.handleWebSocket("node-1", mockWs as never);

    const messageHandler = (mockWs.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "message",
    )?.[1];

    messageHandler(Buffer.from(JSON.stringify({ type: "heartbeat", containers: [] })));

    await new Promise((resolve) => setTimeout(resolve, 10));

    messageHandler(Buffer.from(JSON.stringify({ type: "heartbeat", containers: [] })));

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cleanMock).toHaveBeenCalledTimes(1);
  });
});

describe("re-registration + placement integration", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ncm: NodeConnectionManager;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
    ncm = new NodeConnectionManager(db);
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("node crashes mid-recovery, comes back, not eligible for placement until cleanup", async () => {
    await insertNode(db, { id: "node-1", status: "recovering" });
    await insertNode(db, { id: "node-2", host: "10.0.0.2", capacityMb: 4096, status: "active" });

    await db.insert(recoveryEvents).values({
      id: "evt-1",
      nodeId: "node-1",
      trigger: "heartbeat_timeout",
      status: "in_progress",
      tenantsTotal: 2,
      tenantsRecovered: 0,
      tenantsFailed: 0,
      tenantsWaiting: 2,
      startedAt: 900,
    });

    await ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const node1Rows = await db.select().from(nodes).where(eq(nodes.id, "node-1"));
    expect(node1Rows[0]?.status).toBe("returning");

    const allNodes = await db.select().from(nodes);
    const placement = findPlacement(allNodes, 100);
    expect(placement).not.toBeNull();
    expect(placement?.nodeId).toBe("node-2");

    const evtRows = await db.select().from(recoveryEvents).where(eq(recoveryEvents.id, "evt-1"));
    expect(evtRows[0]?.status).toBe("completed");
    expect(evtRows[0]?.completedAt).not.toBeNull();
  });
});

describe("end-to-end: node crash -> recovery -> reboot -> orphan cleanup", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ncm: NodeConnectionManager;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
  });

  it("full cycle: orphaned containers are stopped, node becomes active", async () => {
    await insertNode(db, { id: "node-1", status: "returning" });
    await insertNode(db, { id: "node-2", host: "10.0.0.2", usedMb: 200, status: "active" });

    await db.insert(botInstances).values([
      { id: "bot-1", tenantId: "tenant-aaa", name: "Bot A", nodeId: "node-2" },
      { id: "bot-2", tenantId: "tenant-bbb", name: "Bot B", nodeId: "node-2" },
    ]);

    const sentCommands: Array<{ nodeId: string; type: string; name: string }> = [];

    ncm = new NodeConnectionManager(db);

    ncm.sendCommand = vi
      .fn()
      .mockImplementation(async (nodeId: string, cmd: { type: string; payload: { name: string } }) => {
        sentCommands.push({ nodeId, type: cmd.type, name: cmd.payload.name });
        return { id: "cmd-1", type: "command_result", command: cmd.type, success: true };
      }) as never;

    const { OrphanCleaner } = await import("./orphan-cleaner.js");
    const { DrizzleNodeRepository } = await import("./drizzle-node-repository.js");
    const { DrizzleBotInstanceRepository } = await import("./drizzle-bot-instance-repository.js");
    const mockCommandBus = {
      send: vi.fn().mockImplementation(async (_nodeId: string, cmd: { type: string; payload: { name: string } }) => {
        sentCommands.push({ nodeId: _nodeId, type: cmd.type, name: cmd.payload.name });
        return { id: "cmd-1", type: "command_result", command: cmd.type, success: true };
      }),
    };
    const orphanCleaner = new OrphanCleaner(
      new DrizzleNodeRepository(db),
      new DrizzleBotInstanceRepository(db),
      mockCommandBus,
    );
    ncm.setOrphanCleaner(orphanCleaner);

    const mockWs = {
      readyState: 1,
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    };

    ncm.handleWebSocket("node-1", mockWs as never);

    const messageHandler = (mockWs.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "message",
    )?.[1];

    messageHandler(
      Buffer.from(
        JSON.stringify({
          type: "heartbeat",
          containers: [
            { name: "tenant_tenant-aaa", memory_mb: 100 },
            { name: "tenant_tenant-bbb", memory_mb: 100 },
          ],
        }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sentCommands).toHaveLength(2);
    expect(sentCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: "node-1", type: "bot.stop", name: "tenant_tenant-aaa" }),
        expect.objectContaining({ nodeId: "node-1", type: "bot.stop", name: "tenant_tenant-bbb" }),
      ]),
    );

    const node1Rows = await db.select().from(nodes).where(eq(nodes.id, "node-1"));
    expect(node1Rows[0]?.status).toBe("active");

    const bot1Rows = await db.select().from(botInstances).where(eq(botInstances.id, "bot-1"));
    const bot2Rows = await db.select().from(botInstances).where(eq(botInstances.id, "bot-2"));
    expect(bot1Rows[0]?.nodeId).toBe("node-2");
    expect(bot2Rows[0]?.nodeId).toBe("node-2");
  });
});
