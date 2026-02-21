import { describe, expect, it, vi } from "vitest";

// We test RecoveryManager by verifying the bot.import command payload
// Uses a real in-memory SQLite database with Drizzle

import Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema/index.js";
import type { AdminNotifier } from "./admin-notifier.js";
import type { NodeConnectionManager } from "./node-connection-manager.js";
import { RecoveryManager } from "./recovery-manager.js";

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

function createMockNodeConnections(sendCommandFn?: (...args: unknown[]) => unknown) {
  return {
    findBestTarget: vi.fn().mockReturnValue({
      id: "target-node-1",
      host: "10.0.0.2",
      status: "active",
      capacityMb: 4096,
      usedMb: 512,
    }),
    sendCommand:
      sendCommandFn ??
      vi.fn().mockResolvedValue({
        id: "cmd-1",
        type: "command_result",
        command: "test",
        success: true,
      }),
    reassignTenant: vi.fn(),
    addNodeCapacity: vi.fn(),
  } as unknown as NodeConnectionManager;
}

function createMockNotifier() {
  return {
    nodeRecoveryComplete: vi.fn().mockResolvedValue(undefined),
    capacityOverflow: vi.fn().mockResolvedValue(undefined),
    nodeStatusChange: vi.fn().mockResolvedValue(undefined),
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
      const nodeConnections = createMockNodeConnections(sendCommand);
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
      const nodeConnections = createMockNodeConnections(sendCommand);
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
      const nodeConnections = createMockNodeConnections(sendCommand);
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
