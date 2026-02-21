import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleRecoveryRepository } from "./recovery-repository.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recovery_events (
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
    CREATE INDEX IF NOT EXISTS idx_recovery_events_node ON recovery_events (node_id);
    CREATE INDEX IF NOT EXISTS idx_recovery_events_status ON recovery_events (status);

    CREATE TABLE IF NOT EXISTS recovery_items (
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
    CREATE INDEX IF NOT EXISTS idx_recovery_items_event ON recovery_items (recovery_event_id);
    CREATE INDEX IF NOT EXISTS idx_recovery_items_tenant ON recovery_items (tenant);
  `);
  return drizzle(sqlite, { schema });
}

describe("DrizzleRecoveryRepository", () => {
  let repo: DrizzleRecoveryRepository;

  beforeEach(() => {
    repo = new DrizzleRecoveryRepository(makeDb());
  });

  describe("createEvent", () => {
    it("creates an event with in_progress status", () => {
      const evt = repo.createEvent({
        id: "evt-1",
        nodeId: "node-1",
        trigger: "heartbeat_timeout",
        tenantsTotal: 3,
      });
      expect(evt.id).toBe("evt-1");
      expect(evt.nodeId).toBe("node-1");
      expect(evt.trigger).toBe("heartbeat_timeout");
      expect(evt.status).toBe("in_progress");
      expect(evt.tenantsTotal).toBe(3);
      expect(evt.tenantsRecovered).toBe(0);
      expect(evt.tenantsFailed).toBe(0);
      expect(evt.tenantsWaiting).toBe(0);
      expect(evt.startedAt).toBeGreaterThan(0);
      expect(evt.completedAt).toBeNull();
      expect(evt.reportJson).toBeNull();
    });

    it("sets startedAt to current unix epoch seconds", () => {
      const before = Math.floor(Date.now() / 1000);
      const evt = repo.createEvent({
        id: "evt-2",
        nodeId: "node-1",
        trigger: "manual",
        tenantsTotal: 1,
      });
      const after = Math.floor(Date.now() / 1000);
      expect(evt.startedAt).toBeGreaterThanOrEqual(before);
      expect(evt.startedAt).toBeLessThanOrEqual(after);
    });
  });

  describe("getEvent", () => {
    it("returns null for nonexistent event", () => {
      expect(repo.getEvent("nonexistent")).toBeNull();
    });

    it("returns the event after creation", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 2 });
      const evt = repo.getEvent("evt-1");
      expect(evt).not.toBeNull();
      expect(evt?.id).toBe("evt-1");
      expect(evt?.tenantsTotal).toBe(2);
    });
  });

  describe("updateEvent", () => {
    it("updates event fields and returns updated event", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 3 });
      const updated = repo.updateEvent("evt-1", {
        status: "completed",
        tenantsRecovered: 3,
        completedAt: Math.floor(Date.now() / 1000),
      });
      expect(updated.status).toBe("completed");
      expect(updated.tenantsRecovered).toBe(3);
      expect(updated.completedAt).not.toBeNull();
    });

    it("partial update does not reset other fields", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "heartbeat_timeout", tenantsTotal: 5 });
      repo.updateEvent("evt-1", { tenantsRecovered: 2 });
      const evt = repo.getEvent("evt-1");
      expect(evt?.tenantsTotal).toBe(5);
      expect(evt?.tenantsRecovered).toBe(2);
      expect(evt?.status).toBe("in_progress");
    });
  });

  describe("createItem", () => {
    it("creates an item with waiting status and retryCount 0", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      const item = repo.createItem({
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "tenant-a",
        sourceNode: "node-1",
        backupKey: "latest/tenant_a/latest.tar.gz",
      });
      expect(item.id).toBe("item-1");
      expect(item.recoveryEventId).toBe("evt-1");
      expect(item.tenant).toBe("tenant-a");
      expect(item.sourceNode).toBe("node-1");
      expect(item.status).toBe("waiting");
      expect(item.retryCount).toBe(0);
      expect(item.targetNode).toBeNull();
      expect(item.reason).toBeNull();
      expect(item.startedAt).toBeGreaterThan(0);
      expect(item.completedAt).toBeNull();
    });
  });

  describe("updateItem", () => {
    it("updates item status and target node", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      repo.createItem({
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "tenant-a",
        sourceNode: "node-1",
        backupKey: "key",
      });
      const updated = repo.updateItem("item-1", {
        status: "recovered",
        targetNode: "node-2",
        completedAt: Math.floor(Date.now() / 1000),
      });
      expect(updated.status).toBe("recovered");
      expect(updated.targetNode).toBe("node-2");
      expect(updated.completedAt).not.toBeNull();
    });

    it("can set a failure reason", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      repo.createItem({
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "tenant-a",
        sourceNode: "node-1",
        backupKey: "key",
      });
      const updated = repo.updateItem("item-1", {
        status: "failed",
        reason: "no_capacity",
      });
      expect(updated.status).toBe("failed");
      expect(updated.reason).toBe("no_capacity");
    });
  });

  describe("listOpenEvents", () => {
    it("returns events with in_progress status", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      const open = repo.listOpenEvents();
      expect(open).toHaveLength(1);
      expect(open[0].id).toBe("evt-1");
      expect(open[0].status).toBe("in_progress");
    });

    it("returns events with partial status", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 3 });
      repo.updateEvent("evt-1", { status: "partial", tenantsWaiting: 1 });
      const open = repo.listOpenEvents();
      expect(open).toHaveLength(1);
      expect(open[0].status).toBe("partial");
    });

    it("does NOT return completed events", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      repo.updateEvent("evt-1", { status: "completed", completedAt: Math.floor(Date.now() / 1000) });
      const open = repo.listOpenEvents();
      expect(open).toHaveLength(0);
    });

    it("returns multiple open events from different nodes", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      repo.createEvent({ id: "evt-2", nodeId: "node-2", trigger: "heartbeat_timeout", tenantsTotal: 2 });
      repo.createEvent({ id: "evt-3", nodeId: "node-3", trigger: "manual", tenantsTotal: 1 });
      repo.updateEvent("evt-3", { status: "completed" });
      const open = repo.listOpenEvents();
      expect(open).toHaveLength(2);
      const ids = open.map((e) => e.id).sort();
      expect(ids).toEqual(["evt-1", "evt-2"]);
    });

    it("returns empty array when no events exist", () => {
      expect(repo.listOpenEvents()).toEqual([]);
    });
  });

  describe("getWaitingItems", () => {
    it("returns only items with waiting status for given event", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 3 });
      repo.createItem({ id: "item-1", recoveryEventId: "evt-1", tenant: "t-a", sourceNode: "node-1", backupKey: "k1" });
      repo.createItem({ id: "item-2", recoveryEventId: "evt-1", tenant: "t-b", sourceNode: "node-1", backupKey: "k2" });
      repo.createItem({ id: "item-3", recoveryEventId: "evt-1", tenant: "t-c", sourceNode: "node-1", backupKey: "k3" });
      // Mark item-1 as recovered
      repo.updateItem("item-1", { status: "recovered", targetNode: "node-2" });
      const waiting = repo.getWaitingItems("evt-1");
      expect(waiting).toHaveLength(2);
      expect(waiting.every((i) => i.status === "waiting")).toBe(true);
    });

    it("returns empty array when no waiting items", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      repo.createItem({ id: "item-1", recoveryEventId: "evt-1", tenant: "t-a", sourceNode: "node-1", backupKey: "k1" });
      repo.updateItem("item-1", { status: "recovered", targetNode: "node-2" });
      expect(repo.getWaitingItems("evt-1")).toEqual([]);
    });

    it("does not return items from a different event", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      repo.createEvent({ id: "evt-2", nodeId: "node-2", trigger: "manual", tenantsTotal: 1 });
      repo.createItem({ id: "item-1", recoveryEventId: "evt-1", tenant: "t-a", sourceNode: "node-1", backupKey: "k1" });
      repo.createItem({ id: "item-2", recoveryEventId: "evt-2", tenant: "t-b", sourceNode: "node-2", backupKey: "k2" });
      const waiting = repo.getWaitingItems("evt-1");
      expect(waiting).toHaveLength(1);
      expect(waiting[0].tenant).toBe("t-a");
    });
  });

  describe("incrementRetryCount", () => {
    it("increments retryCount atomically by 1", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      repo.createItem({ id: "item-1", recoveryEventId: "evt-1", tenant: "t-a", sourceNode: "node-1", backupKey: "k1" });
      expect(repo.getWaitingItems("evt-1")[0].retryCount).toBe(0);
      repo.incrementRetryCount("item-1");
      // Re-fetch via getWaitingItems to verify
      expect(repo.getWaitingItems("evt-1")[0].retryCount).toBe(1);
      repo.incrementRetryCount("item-1");
      expect(repo.getWaitingItems("evt-1")[0].retryCount).toBe(2);
    });

    it("only increments the targeted item", () => {
      repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 2 });
      repo.createItem({ id: "item-1", recoveryEventId: "evt-1", tenant: "t-a", sourceNode: "node-1", backupKey: "k1" });
      repo.createItem({ id: "item-2", recoveryEventId: "evt-1", tenant: "t-b", sourceNode: "node-1", backupKey: "k2" });
      repo.incrementRetryCount("item-1");
      repo.incrementRetryCount("item-1");
      repo.incrementRetryCount("item-1");
      const items = repo.getWaitingItems("evt-1");
      const item1 = items.find((i) => i.id === "item-1");
      const item2 = items.find((i) => i.id === "item-2");
      expect(item1?.retryCount).toBe(3);
      expect(item2?.retryCount).toBe(0);
    });
  });
});
