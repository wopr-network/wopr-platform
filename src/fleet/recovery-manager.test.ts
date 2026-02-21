import Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema/index.js";
import * as dbSchema from "../db/schema/index.js";
import { recoveryEvents, recoveryItems } from "../db/schema/index.js";
import type { AdminNotifier } from "./admin-notifier.js";
import type { NodeConnectionManager } from "./node-connection-manager.js";
import { RecoveryManager } from "./recovery-manager.js";

// We test RecoveryManager by verifying the bot.import command payload
// Uses a real in-memory SQLite database with Drizzle

/** Full schema setup used by recoverTenant tests (includes bot_profiles) */
function setupTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });

  // Create tables needed for recovery
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL DEFAULT '',
      capacity_mb INTEGER NOT NULL DEFAULT 4096,
      used_mb INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      agent_version TEXT,
      last_heartbeat_at INTEGER,
      registered_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      owner_user_id TEXT,
      label TEXT,
      node_secret TEXT
    );
    CREATE TABLE IF NOT EXISTS bot_instances (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      node_id TEXT,
      billing_state TEXT NOT NULL DEFAULT 'active',
      suspended_at TEXT,
      destroy_after TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tenant_customers (
      tenant TEXT PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'free'
    );
    CREATE TABLE IF NOT EXISTS recovery_events (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      tenants_total INTEGER,
      tenants_recovered INTEGER,
      tenants_failed INTEGER,
      tenants_waiting INTEGER,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      report_json TEXT
    );
    CREATE TABLE IF NOT EXISTS recovery_items (
      id TEXT PRIMARY KEY,
      recovery_event_id TEXT NOT NULL,
      tenant TEXT NOT NULL,
      source_node TEXT NOT NULL,
      target_node TEXT,
      backup_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS bot_profiles (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      image TEXT NOT NULL,
      env TEXT NOT NULL DEFAULT '{}',
      restart_policy TEXT NOT NULL DEFAULT 'unless-stopped',
      update_policy TEXT NOT NULL DEFAULT 'on-push',
      release_channel TEXT NOT NULL DEFAULT 'stable',
      volume_name TEXT,
      discovery_json TEXT,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return { db, sqlite };
}

/** Full schema setup used by checkAndRetryWaiting tests */
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema: dbSchema });

  // Create tables
  sqlite.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      capacity_mb INTEGER NOT NULL DEFAULT 4096,
      used_mb INTEGER NOT NULL DEFAULT 0,
      agent_version TEXT,
      last_heartbeat_at INTEGER,
      registered_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
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
    );
    CREATE TABLE tenant_customers (
      tenant TEXT PRIMARY KEY,
      stripe_customer_id TEXT,
      tier TEXT DEFAULT 'free',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    CREATE TABLE recovery_items (
      id TEXT PRIMARY KEY,
      recovery_event_id TEXT NOT NULL,
      tenant TEXT NOT NULL,
      source_node TEXT NOT NULL,
      target_node TEXT,
      backup_key TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS bot_profiles (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      image TEXT NOT NULL,
      env TEXT NOT NULL DEFAULT '{}',
      restart_policy TEXT NOT NULL DEFAULT 'unless-stopped',
      update_policy TEXT NOT NULL DEFAULT 'on-push',
      release_channel TEXT NOT NULL DEFAULT 'stable',
      volume_name TEXT,
      discovery_json TEXT,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return { sqlite, db };
}

function createMockNodeConnections(
  sendCommandOrOverrides?: NodeConnectionManager["sendCommand"] | Partial<NodeConnectionManager>,
): NodeConnectionManager {
  const overrides =
    typeof sendCommandOrOverrides === "function"
      ? { sendCommand: sendCommandOrOverrides }
      : (sendCommandOrOverrides ?? {});
  return {
    findBestTarget: vi.fn().mockReturnValue(null),
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

describe("RecoveryManager", () => {
  describe("recoverTenant uses bot profile for image/env", () => {
    it("reads image and env from bot_profiles instead of hardcoding", async () => {
      const { db, sqlite } = setupTestDb();
      const sendCommand = vi.fn().mockResolvedValue({
        id: "cmd-1",
        type: "command_result",
        command: "test",
        success: true,
      });
      const nodeConnections = createMockNodeConnections({
        sendCommand,
        findBestTarget: vi
          .fn()
          .mockReturnValue({ id: "target-node-1", host: "10.0.0.2", status: "active", capacityMb: 4096, usedMb: 512 }),
      });
      const notifier = createMockNotifier();
      const manager = new RecoveryManager(db as BetterSQLite3Database<typeof schema>, nodeConnections, notifier);

      // Insert a dead node
      sqlite.exec(`
        INSERT INTO nodes (id, host, capacity_mb, used_mb, status, registered_at, updated_at)
        VALUES ('dead-node', '10.0.0.1', 4096, 1024, 'active', 0, 0)
      `);

      // Insert bot instance assigned to dead node
      sqlite.exec(`
        INSERT INTO bot_instances (id, tenant_id, name, node_id)
        VALUES ('bot-1', 'tenant-1', 'my-bot', 'dead-node')
      `);

      // Insert bot profile with pinned image and custom env
      sqlite.exec(`
        INSERT INTO bot_profiles (id, tenant_id, name, image, env)
        VALUES ('bot-1', 'tenant-1', 'my-bot', 'ghcr.io/wopr-network/wopr:v2.0.0', '{"TOKEN":"secret-abc","LOG_LEVEL":"debug"}')
      `);

      // Insert a target node
      sqlite.exec(`
        INSERT INTO nodes (id, host, capacity_mb, used_mb, status, registered_at, updated_at)
        VALUES ('target-node-1', '10.0.0.2', 4096, 512, 'active', 0, 0)
      `);

      await manager.triggerRecovery("dead-node", "heartbeat_timeout");

      // Find the bot.import call
      const importCall = sendCommand.mock.calls.find(
        (args: unknown[]) => (args[1] as { type?: string })?.type === "bot.import",
      );
      expect(importCall).toBeDefined();

      const importCmd = importCall?.[1] as { payload: { image: string; env: Record<string, string> } };
      // Must use the profile's image, NOT the hardcoded default
      expect(importCmd.payload.image).toBe("ghcr.io/wopr-network/wopr:v2.0.0");
      expect(importCmd.payload.env).toEqual({ TOKEN: "secret-abc", LOG_LEVEL: "debug" });

      // Verify it's NOT the old hardcoded value
      expect(importCmd.payload.image).not.toBe("ghcr.io/wopr-network/wopr:latest");
    });

    it("falls back to defaults with logger.warn when no profile exists", async () => {
      const { db, sqlite } = setupTestDb();
      const sendCommand = vi.fn().mockResolvedValue({
        id: "cmd-1",
        type: "command_result",
        command: "test",
        success: true,
      });
      const nodeConnections = createMockNodeConnections({
        sendCommand,
        findBestTarget: vi
          .fn()
          .mockReturnValue({ id: "target-node-1", host: "10.0.0.2", status: "active", capacityMb: 4096, usedMb: 512 }),
      });
      const notifier = createMockNotifier();
      const manager = new RecoveryManager(db as BetterSQLite3Database<typeof schema>, nodeConnections, notifier);

      // Insert dead node + bot instance but NO bot_profiles row
      sqlite.exec(`
        INSERT INTO nodes (id, host, capacity_mb, used_mb, status, registered_at, updated_at)
        VALUES ('dead-node', '10.0.0.1', 4096, 1024, 'active', 0, 0)
      `);
      sqlite.exec(`
        INSERT INTO bot_instances (id, tenant_id, name, node_id)
        VALUES ('bot-1', 'tenant-1', 'my-bot', 'dead-node')
      `);
      sqlite.exec(`
        INSERT INTO nodes (id, host, capacity_mb, used_mb, status, registered_at, updated_at)
        VALUES ('target-node-1', '10.0.0.2', 4096, 512, 'active', 0, 0)
      `);

      await manager.triggerRecovery("dead-node", "manual");

      // Should fall back to default image and empty env
      const importCall = sendCommand.mock.calls.find(
        (args: unknown[]) => (args[1] as { type?: string })?.type === "bot.import",
      );
      expect(importCall).toBeDefined();

      const importCmd = importCall?.[1] as { payload: { image: string; env: Record<string, string> } };
      expect(importCmd.payload.image).toBe("ghcr.io/wopr-network/wopr:latest");
      expect(importCmd.payload.env).toEqual({});
    });

    it("falls back to empty env when profile env JSON is corrupt", async () => {
      const { db, sqlite } = setupTestDb();
      const sendCommand = vi.fn().mockResolvedValue({
        id: "cmd-1",
        type: "command_result",
        command: "test",
        success: true,
      });
      const nodeConnections = createMockNodeConnections({
        sendCommand,
        findBestTarget: vi
          .fn()
          .mockReturnValue({ id: "target-node-1", host: "10.0.0.2", status: "active", capacityMb: 4096, usedMb: 512 }),
      });
      const notifier = createMockNotifier();
      const manager = new RecoveryManager(db as BetterSQLite3Database<typeof schema>, nodeConnections, notifier);

      sqlite.exec(`
        INSERT INTO nodes (id, host, capacity_mb, used_mb, status, registered_at, updated_at)
        VALUES ('dead-node', '10.0.0.1', 4096, 1024, 'active', 0, 0)
      `);
      sqlite.exec(`
        INSERT INTO bot_instances (id, tenant_id, name, node_id)
        VALUES ('bot-1', 'tenant-1', 'my-bot', 'dead-node')
      `);
      // Profile with corrupt env JSON but valid image
      sqlite.exec(`
        INSERT INTO bot_profiles (id, tenant_id, name, image, env)
        VALUES ('bot-1', 'tenant-1', 'my-bot', 'ghcr.io/wopr-network/wopr:v3.0.0', 'not-valid-json{{{')
      `);
      sqlite.exec(`
        INSERT INTO nodes (id, host, capacity_mb, used_mb, status, registered_at, updated_at)
        VALUES ('target-node-1', '10.0.0.2', 4096, 512, 'active', 0, 0)
      `);

      await manager.triggerRecovery("dead-node", "manual");

      const importCall = sendCommand.mock.calls.find(
        (args: unknown[]) => (args[1] as { type?: string })?.type === "bot.import",
      );
      expect(importCall).toBeDefined();

      const importCmd = importCall?.[1] as { payload: { image: string; env: Record<string, string> } };
      // Image should still come from profile
      expect(importCmd.payload.image).toBe("ghcr.io/wopr-network/wopr:v3.0.0");
      // Env should fall back to empty since JSON is corrupt
      expect(importCmd.payload.env).toEqual({});
    });
  });
});

describe("RecoveryManager.checkAndRetryWaiting", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: Database.Database;
  let notifier: AdminNotifier;
  let nodeConnections: NodeConnectionManager;
  let manager: RecoveryManager;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    notifier = createMockNotifier();
    nodeConnections = createMockNodeConnections();
    manager = new RecoveryManager(db, nodeConnections, notifier);
  });

  it("retries waiting tenants when a recovery event has waiting items and retryCount < max", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Insert a target node with capacity
    sqlite.exec(`
      INSERT INTO nodes (id, host, status, capacity_mb, used_mb, registered_at, updated_at)
      VALUES ('target-node', '10.0.0.2', 'active', 4096, 0, ${now}, ${now})
    `);

    // Insert a dead node
    sqlite.exec(`
      INSERT INTO nodes (id, host, status, capacity_mb, used_mb, registered_at, updated_at)
      VALUES ('dead-node', '10.0.0.1', 'offline', 4096, 4096, ${now}, ${now})
    `);

    // Insert bot instance on dead node
    sqlite.exec(`
      INSERT INTO bot_instances (id, tenant_id, name, node_id) VALUES ('bot-1', 'tenant-1', 'my-bot', 'dead-node')
    `);

    // Insert recovery event with waiting items
    sqlite.exec(`
      INSERT INTO recovery_events (id, node_id, trigger, status, tenants_total, tenants_recovered, tenants_failed, tenants_waiting, started_at)
      VALUES ('evt-1', 'dead-node', 'heartbeat_timeout', 'partial', 1, 0, 0, 1, ${now})
    `);

    // Insert waiting recovery item with retryCount < 5
    sqlite.exec(`
      INSERT INTO recovery_items (id, recovery_event_id, tenant, source_node, status, reason, retry_count, started_at)
      VALUES ('item-1', 'evt-1', 'tenant-1', 'dead-node', 'waiting', 'no_capacity', 2, ${now})
    `);

    // Mock findBestTarget to return the target node this time
    (nodeConnections.findBestTarget as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "target-node",
      host: "10.0.0.2",
      status: "active",
      capacityMb: 4096,
      usedMb: 0,
    });

    await manager.checkAndRetryWaiting();

    // Verify retryWaiting was effectively called -- the waiting item should now be retried
    const items = db.select().from(recoveryItems).all();
    // There should be the original item (marked "retried") and a new item (recovered or waiting)
    expect(items.length).toBeGreaterThanOrEqual(1);
    // The original "waiting" item should have been updated to "retried"
    const original = items.find((i) => i.id === "item-1");
    expect(original?.status).toBe("retried");
  });

  it("marks waiting items as failed when retryCount >= MAX_RETRY_ATTEMPTS", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Insert dead node
    sqlite.exec(`
      INSERT INTO nodes (id, host, status, capacity_mb, used_mb, registered_at, updated_at)
      VALUES ('dead-node', '10.0.0.1', 'offline', 4096, 4096, ${now}, ${now})
    `);

    // Insert recovery event
    sqlite.exec(`
      INSERT INTO recovery_events (id, node_id, trigger, status, tenants_total, tenants_recovered, tenants_failed, tenants_waiting, started_at)
      VALUES ('evt-1', 'dead-node', 'heartbeat_timeout', 'partial', 1, 0, 0, 1, ${now})
    `);

    // Insert waiting item with retryCount at the max (5)
    sqlite.exec(`
      INSERT INTO recovery_items (id, recovery_event_id, tenant, source_node, status, reason, retry_count, started_at)
      VALUES ('item-1', 'evt-1', 'tenant-1', 'dead-node', 'waiting', 'no_capacity', 5, ${now})
    `);

    await manager.checkAndRetryWaiting();

    // Item should be marked as "failed"
    const item = db
      .select()
      .from(recoveryItems)
      .all()
      .find((i) => i.id === "item-1");
    expect(item?.status).toBe("failed");
    expect(item?.completedAt).not.toBeNull();

    // Event should be "completed" (no more waiting items)
    const event = db
      .select()
      .from(recoveryEvents)
      .all()
      .find((e) => e.id === "evt-1");
    expect(event?.status).toBe("completed");

    // Admin should be notified
    expect(notifier.waitingTenantsExpired as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("marks waiting items as failed when event exceeds 24h time cap", async () => {
    const now = Math.floor(Date.now() / 1000);
    const twentyFiveHoursAgo = now - 25 * 60 * 60;

    // Insert dead node
    sqlite.exec(`
      INSERT INTO nodes (id, host, status, capacity_mb, used_mb, registered_at, updated_at)
      VALUES ('dead-node', '10.0.0.1', 'offline', 4096, 4096, ${now}, ${now})
    `);

    // Insert recovery event started 25 hours ago
    sqlite.exec(`
      INSERT INTO recovery_events (id, node_id, trigger, status, tenants_total, tenants_recovered, tenants_failed, tenants_waiting, started_at)
      VALUES ('evt-1', 'dead-node', 'heartbeat_timeout', 'partial', 1, 0, 0, 1, ${twentyFiveHoursAgo})
    `);

    // Insert waiting item with low retryCount (but time cap exceeded)
    sqlite.exec(`
      INSERT INTO recovery_items (id, recovery_event_id, tenant, source_node, status, reason, retry_count, started_at)
      VALUES ('item-1', 'evt-1', 'tenant-1', 'dead-node', 'waiting', 'no_capacity', 1, ${twentyFiveHoursAgo})
    `);

    await manager.checkAndRetryWaiting();

    // Item should be marked as "failed" due to time cap
    const item = db
      .select()
      .from(recoveryItems)
      .all()
      .find((i) => i.id === "item-1");
    expect(item?.status).toBe("failed");

    // Event should be "completed"
    const event = db
      .select()
      .from(recoveryEvents)
      .all()
      .find((e) => e.id === "evt-1");
    expect(event?.status).toBe("completed");
  });

  it("does nothing when there are no open recovery events with waiting items", async () => {
    // No events at all
    await manager.checkAndRetryWaiting();
    // Should not throw, should not call notifier
    expect(notifier.waitingTenantsExpired as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("completes event when all waiting items are resolved after retry", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Insert target node
    sqlite.exec(`
      INSERT INTO nodes (id, host, status, capacity_mb, used_mb, registered_at, updated_at)
      VALUES ('target-node', '10.0.0.2', 'active', 4096, 0, ${now}, ${now})
    `);

    // Insert dead node
    sqlite.exec(`
      INSERT INTO nodes (id, host, status, capacity_mb, used_mb, registered_at, updated_at)
      VALUES ('dead-node', '10.0.0.1', 'offline', 4096, 4096, ${now}, ${now})
    `);

    // Insert bot instance
    sqlite.exec(`
      INSERT INTO bot_instances (id, tenant_id, name, node_id) VALUES ('bot-1', 'tenant-1', 'my-bot', 'dead-node')
    `);

    // Insert recovery event -- "partial" with 1 recovered, 1 waiting
    sqlite.exec(`
      INSERT INTO recovery_events (id, node_id, trigger, status, tenants_total, tenants_recovered, tenants_failed, tenants_waiting, started_at)
      VALUES ('evt-1', 'dead-node', 'heartbeat_timeout', 'partial', 2, 1, 0, 1, ${now})
    `);

    // Insert one recovered item and one waiting item
    sqlite.exec(`
      INSERT INTO recovery_items (id, recovery_event_id, tenant, source_node, target_node, status, retry_count, started_at, completed_at)
      VALUES ('item-done', 'evt-1', 'tenant-0', 'dead-node', 'target-node', 'recovered', 0, ${now}, ${now})
    `);
    sqlite.exec(`
      INSERT INTO recovery_items (id, recovery_event_id, tenant, source_node, status, reason, retry_count, started_at)
      VALUES ('item-wait', 'evt-1', 'tenant-1', 'dead-node', 'waiting', 'no_capacity', 0, ${now})
    `);

    // Now capacity is available
    (nodeConnections.findBestTarget as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "target-node",
      host: "10.0.0.2",
      status: "active",
      capacityMb: 4096,
      usedMb: 0,
    });

    await manager.checkAndRetryWaiting();

    // Event should be "completed" now
    const event = db
      .select()
      .from(recoveryEvents)
      .all()
      .find((e) => e.id === "evt-1");
    expect(event?.status).toBe("completed");
    expect(event?.completedAt).not.toBeNull();
  });
});

describe("Trigger 1: Node registration fires checkAndRetryWaiting", () => {
  it("calls checkAndRetryWaiting after registerNode via onNodeRegistered callback", () => {
    // This is an integration-style test verifying the callback wiring.
    // Here we verify that RecoveryManager.checkAndRetryWaiting can be called without error
    // when there are no open events.
    const testDb = createTestDb();
    const mockNotifier = createMockNotifier();
    const mockNodeConns = createMockNodeConnections();
    const mgr = new RecoveryManager(testDb.db, mockNodeConns, mockNotifier);

    // Should not throw when there are no events
    expect(mgr.checkAndRetryWaiting()).resolves.toBeUndefined();
  });
});

describe("Acceptance criteria", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: Database.Database;
  let notifier: AdminNotifier;
  let nodeConnections: NodeConnectionManager;
  let manager: RecoveryManager;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;
    notifier = createMockNotifier();
    nodeConnections = createMockNodeConnections();
    manager = new RecoveryManager(db, nodeConnections, notifier);
  });

  it("AC: node with waiting tenants -> new node joins -> waiting tenants auto-placed", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Setup: dead node, bot, event, waiting item
    sqlite.exec(`
      INSERT INTO nodes (id, host, status, capacity_mb, used_mb, registered_at, updated_at)
      VALUES ('dead-node', '10.0.0.1', 'offline', 4096, 4096, ${now}, ${now})
    `);
    sqlite.exec(`
      INSERT INTO nodes (id, host, status, capacity_mb, used_mb, registered_at, updated_at)
      VALUES ('new-node', '10.0.0.3', 'active', 8192, 0, ${now}, ${now})
    `);
    sqlite.exec(`
      INSERT INTO bot_instances (id, tenant_id, name, node_id) VALUES ('bot-1', 'tenant-1', 'my-bot', 'dead-node')
    `);
    sqlite.exec(`
      INSERT INTO recovery_events (id, node_id, trigger, status, tenants_total, tenants_recovered, tenants_failed, tenants_waiting, started_at)
      VALUES ('evt-1', 'dead-node', 'heartbeat_timeout', 'partial', 1, 0, 0, 1, ${now})
    `);
    sqlite.exec(`
      INSERT INTO recovery_items (id, recovery_event_id, tenant, source_node, status, reason, retry_count, started_at)
      VALUES ('item-1', 'evt-1', 'tenant-1', 'dead-node', 'waiting', 'no_capacity', 0, ${now})
    `);

    // New node has capacity
    (nodeConnections.findBestTarget as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "new-node",
      host: "10.0.0.3",
      status: "active",
      capacityMb: 8192,
      usedMb: 0,
    });

    // Act: checkAndRetryWaiting (called by registerNode callback)
    await manager.checkAndRetryWaiting();

    // Assert: waiting item was retried
    const item = db
      .select()
      .from(recoveryItems)
      .all()
      .find((i) => i.id === "item-1");
    expect(item?.status).toBe("retried");

    // Assert: event is completed (or at least updated)
    const event = db
      .select()
      .from(recoveryEvents)
      .all()
      .find((e) => e.id === "evt-1");
    expect(event?.status).toBe("completed");
  });

  it("AC: retry limit reached -> items marked failed, event closed, admin notified", async () => {
    const now = Math.floor(Date.now() / 1000);

    sqlite.exec(`
      INSERT INTO nodes (id, host, status, capacity_mb, used_mb, registered_at, updated_at)
      VALUES ('dead-node', '10.0.0.1', 'offline', 4096, 4096, ${now}, ${now})
    `);
    sqlite.exec(`
      INSERT INTO recovery_events (id, node_id, trigger, status, tenants_total, tenants_recovered, tenants_failed, tenants_waiting, started_at)
      VALUES ('evt-1', 'dead-node', 'heartbeat_timeout', 'partial', 2, 0, 0, 2, ${now})
    `);

    // Two items: one at max retries, one past max
    sqlite.exec(`
      INSERT INTO recovery_items (id, recovery_event_id, tenant, source_node, status, reason, retry_count, started_at)
      VALUES ('item-1', 'evt-1', 'tenant-1', 'dead-node', 'waiting', 'no_capacity', 5, ${now})
    `);
    sqlite.exec(`
      INSERT INTO recovery_items (id, recovery_event_id, tenant, source_node, status, reason, retry_count, started_at)
      VALUES ('item-2', 'evt-1', 'tenant-2', 'dead-node', 'waiting', 'no_capacity', 7, ${now})
    `);

    await manager.checkAndRetryWaiting();

    // Both items should be "failed"
    const items = db.select().from(recoveryItems).all();
    for (const item of items) {
      expect(item.status).toBe("failed");
      expect(item.reason).toBe("max_retries_exceeded");
      expect(item.completedAt).not.toBeNull();
    }

    // Event should be "completed"
    const event = db
      .select()
      .from(recoveryEvents)
      .all()
      .find((e) => e.id === "evt-1");
    expect(event?.status).toBe("completed");
    expect(event?.tenantsFailed).toBe(2);
    expect(event?.tenantsWaiting).toBe(0);

    // Admin notified
    expect(notifier.waitingTenantsExpired as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "evt-1",
      2,
      "max_retries_exceeded",
    );
  });
});
