import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { nodes, recoveryEvents } from "../db/schema/index.js";
import { NodeConnectionManager } from "./node-connection-manager.js";
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
    )
  `);

  sqlite.exec(`
    CREATE TABLE node_transitions (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      reason TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  sqlite.exec(`
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
    )
  `);

  sqlite.exec(`
    CREATE TABLE bot_instances (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      node_id TEXT,
      billing_state TEXT NOT NULL DEFAULT 'active',
      suspended_at TEXT,
      destroy_after TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return { db, sqlite };
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
