import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema/index.js";
import { botInstances, nodes, recoveryEvents } from "../db/schema/index.js";
import { NodeConnectionManager } from "./node-connection-manager.js";
import type { OrphanCleaner } from "./orphan-cleaner.js";
import { findPlacement } from "./placement.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });

  sqlite.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      capacity_mb INTEGER NOT NULL,
      used_mb INTEGER NOT NULL DEFAULT 0,
      agent_version TEXT,
      last_heartbeat_at INTEGER,
      registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      droplet_id TEXT,
      region TEXT,
      size TEXT,
      monthly_cost_cents INTEGER,
      provision_stage TEXT,
      last_error TEXT,
      drain_status TEXT,
      drain_migrated INTEGER,
      drain_total INTEGER,
      owner_user_id TEXT,
      node_secret TEXT,
      label TEXT
    );
    CREATE TABLE node_transitions (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      reason TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE recovery_events (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      tenants_total INTEGER,
      tenants_recovered INTEGER,
      tenants_failed INTEGER,
      tenants_waiting INTEGER,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      report_json TEXT
    );
    CREATE TABLE bot_instances (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      node_id TEXT,
      billing_state TEXT NOT NULL DEFAULT 'active',
      suspended_at TEXT,
      destroy_after TEXT,
      resource_tier TEXT NOT NULL DEFAULT 'standard',
      storage_tier TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return { db, sqlite };
}

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

describe("NodeConnectionManager.registerNode", () => {
  let db: ReturnType<typeof setupDb>["db"];
  let sqlite: Database.Database;
  let ncm: NodeConnectionManager;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
    ncm = new NodeConnectionManager(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("sets status to active for a brand-new node", () => {
    ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const node = db.select().from(nodes).where(eq(nodes.id, "node-1")).get();
    expect(node).toBeDefined();
    expect(node?.status).toBe("active");
  });

  it("sets status to returning for a node that was offline", () => {
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "offline",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const node = db.select().from(nodes).where(eq(nodes.id, "node-1")).get();
    expect(node?.status).toBe("returning");
  });

  it("sets status to returning for a node that was recovering", () => {
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "recovering",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const node = db.select().from(nodes).where(eq(nodes.id, "node-1")).get();
    expect(node?.status).toBe("returning");
  });

  it("sets status to returning for a node that was failed", () => {
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "failed",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const node = db.select().from(nodes).where(eq(nodes.id, "node-1")).get();
    expect(node?.status).toBe("returning");
  });

  it("re-registers an active node as still active (no regression)", () => {
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "active",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.2",
      capacity_mb: 16384,
      agent_version: "2.0.0",
    });

    const node = db.select().from(nodes).where(eq(nodes.id, "node-1")).get();
    expect(node?.status).toBe("active");
    expect(node?.host).toBe("10.0.0.2");
    expect(node?.capacityMb).toBe(16384);
  });

  it("re-registers an unhealthy node as active (heartbeat recovery)", () => {
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "unhealthy",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const node = db.select().from(nodes).where(eq(nodes.id, "node-1")).get();
    expect(node?.status).toBe("active");
  });

  it("closes in-flight recovery events for the returning node", () => {
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "offline",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    db.insert(recoveryEvents)
      .values({
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
      })
      .run();

    ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    const evt = db.select().from(recoveryEvents).where(eq(recoveryEvents.id, "evt-1")).get();
    expect(evt?.status).toBe("completed");
    expect(evt?.completedAt).toBeDefined();
    expect(evt?.completedAt).not.toBeNull();
  });
});

describe("NodeConnectionManager.processHeartbeat — returning status preservation", () => {
  let db: ReturnType<typeof setupDb>["db"];
  let sqlite: Database.Database;
  let ncm: NodeConnectionManager;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
    ncm = new NodeConnectionManager(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("does not override returning status to active on heartbeat", () => {
    // Seed a returning node (just re-registered from dead state)
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "returning",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    // Wire a fake WebSocket for node-1 so handleWebSocket registers message handler
    const fakeWs = Object.assign(new EventEmitter(), { readyState: 1 });
    ncm.handleWebSocket("node-1", fakeWs as unknown as import("ws").WebSocket);

    // Emit a heartbeat message — this calls handleMessage → processHeartbeat
    const heartbeat = Buffer.from(JSON.stringify({ type: "heartbeat", containers: [] }));
    fakeWs.emit("message", heartbeat);

    // processHeartbeat must NOT flip "returning" to "active"
    const node = db.select().from(nodes).where(eq(nodes.id, "node-1")).get();
    expect(node?.status).toBe("returning");
  });
});

describe("NodeConnectionManager heartbeat triggers OrphanCleaner for returning nodes", () => {
  let db: ReturnType<typeof setupDb>["db"];
  let sqlite: Database.Database;
  let ncm: NodeConnectionManager;
  let orphanCleaner: OrphanCleaner;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
    orphanCleaner = makeOrphanCleaner();
    ncm = new NodeConnectionManager(db);
    ncm.setOrphanCleaner(orphanCleaner);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("triggers OrphanCleaner.clean on first heartbeat from a returning node", async () => {
    // Seed node in "returning" state
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "returning",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    // Simulate heartbeat message
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

    // Get the "message" handler that was registered
    const messageHandler = (mockWs.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "message",
    )?.[1];

    expect(messageHandler).toBeDefined();

    // Fire the heartbeat
    messageHandler(heartbeatMsg);

    // Give the async cleanup a tick to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(orphanCleaner.clean).toHaveBeenCalledWith({
      nodeId: "node-1",
      runningContainers: ["tenant_orphan", "tenant_legit"],
    });
  });

  it("does NOT trigger OrphanCleaner for active nodes", async () => {
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "active",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

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
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "returning",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    // Make the first clean() call transition the node to active (simulating real behavior)
    const cleanMock = vi.fn().mockImplementation(async () => {
      db.update(nodes).set({ status: "active" }).where(eq(nodes.id, "node-1")).run();
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

    // First heartbeat
    messageHandler(Buffer.from(JSON.stringify({ type: "heartbeat", containers: [] })));

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second heartbeat — node is now "active" because clean() transitioned it
    messageHandler(Buffer.from(JSON.stringify({ type: "heartbeat", containers: [] })));

    await new Promise((resolve) => setTimeout(resolve, 10));

    // clean() should have been called exactly once
    expect(cleanMock).toHaveBeenCalledTimes(1);
  });
});

describe("re-registration + placement integration", () => {
  let db: ReturnType<typeof setupDb>["db"];
  let sqlite: Database.Database;
  let ncm: NodeConnectionManager;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
    ncm = new NodeConnectionManager(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("node crashes mid-recovery, comes back, not eligible for placement until cleanup", () => {
    // 1. Node-1 is recovering (crashed and recovery is in flight)
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "recovering",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    // 2. Node-2 is active (healthy target)
    db.insert(nodes)
      .values({
        id: "node-2",
        host: "10.0.0.2",
        capacityMb: 4096,
        usedMb: 0,
        status: "active",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    // 3. In-flight recovery event
    db.insert(recoveryEvents)
      .values({
        id: "evt-1",
        nodeId: "node-1",
        trigger: "heartbeat_timeout",
        status: "in_progress",
        tenantsTotal: 2,
        tenantsRecovered: 0,
        tenantsFailed: 0,
        tenantsWaiting: 2,
        startedAt: 900,
      })
      .run();

    // 4. Node-1 reboots and re-registers
    ncm.registerNode({
      node_id: "node-1",
      host: "10.0.0.1",
      capacity_mb: 8192,
      agent_version: "1.0.0",
    });

    // 5. Verify: node-1 is "returning", not "active"
    const node1 = db.select().from(nodes).where(eq(nodes.id, "node-1")).get();
    expect(node1?.status).toBe("returning");

    // 6. Verify: placement does NOT pick node-1 even though it has more capacity
    const allNodes = db.select().from(nodes).all();
    const placement = findPlacement(allNodes, 100);
    expect(placement).not.toBeNull();
    expect(placement?.nodeId).toBe("node-2"); // node-2, not node-1

    // 7. Verify: recovery event is closed out
    const evt = db.select().from(recoveryEvents).where(eq(recoveryEvents.id, "evt-1")).get();
    expect(evt?.status).toBe("completed");
    expect(evt?.completedAt).not.toBeNull();
  });
});

describe("end-to-end: node crash -> recovery -> reboot -> orphan cleanup", () => {
  let db: ReturnType<typeof setupDb>["db"];
  let sqlite: Database.Database;
  let ncm: NodeConnectionManager;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
  });

  afterEach(() => {
    sqlite.close();
  });

  it("full cycle: orphaned containers are stopped, node becomes active", async () => {
    // === Setup: node-1 has 2 tenants, goes offline, tenants recovered to node-2 ===

    // Node-1: was offline, now rebooting
    db.insert(nodes)
      .values({
        id: "node-1",
        host: "10.0.0.1",
        capacityMb: 8192,
        usedMb: 0,
        status: "returning",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    // Node-2: active, where tenants were migrated to
    db.insert(nodes)
      .values({
        id: "node-2",
        host: "10.0.0.2",
        capacityMb: 8192,
        usedMb: 200,
        status: "active",
        registeredAt: 1000,
        updatedAt: 1000,
      })
      .run();

    // Bot instances: both now assigned to node-2 (recovery already happened)
    db.insert(botInstances)
      .values([
        { id: "bot-1", tenantId: "tenant-aaa", name: "Bot A", nodeId: "node-2" },
        { id: "bot-2", tenantId: "tenant-bbb", name: "Bot B", nodeId: "node-2" },
      ])
      .run();

    // Track what commands were sent
    const sentCommands: Array<{ nodeId: string; type: string; name: string }> = [];

    // Create NCM
    ncm = new NodeConnectionManager(db);

    // Monkey-patch sendCommand for the test
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

    // === Act: simulate first heartbeat from rebooted node-1 ===
    // Node-1 reports containers for tenant_aaa and tenant_bbb (Docker restarted them)
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

    // Wait for async cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // === Assert ===

    // 1. Both orphan containers should have been stopped
    expect(sentCommands).toHaveLength(2);
    expect(sentCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: "node-1", type: "bot.stop", name: "tenant_tenant-aaa" }),
        expect.objectContaining({ nodeId: "node-1", type: "bot.stop", name: "tenant_tenant-bbb" }),
      ]),
    );

    // 2. Node-1 should now be "active"
    const node1 = db.select().from(nodes).where(eq(nodes.id, "node-1")).get();
    expect(node1?.status).toBe("active");

    // 3. Bot instances should still be assigned to node-2 (unchanged)
    const bot1 = db.select().from(botInstances).where(eq(botInstances.id, "bot-1")).get();
    const bot2 = db.select().from(botInstances).where(eq(botInstances.id, "bot-2")).get();
    expect(bot1?.nodeId).toBe("node-2");
    expect(bot2?.nodeId).toBe("node-2");
  });
});
