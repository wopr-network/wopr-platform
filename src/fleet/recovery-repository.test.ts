import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb } from "../test/db.js";
import { DrizzleRecoveryRepository } from "./drizzle-recovery-repository.js";

describe("DrizzleRecoveryRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleRecoveryRepository;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    repo = new DrizzleRecoveryRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  describe("createEvent", () => {
    it("creates an event with in_progress status", async () => {
      const evt = await repo.createEvent({
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

    it("sets startedAt to current unix epoch seconds", async () => {
      const before = Math.floor(Date.now() / 1000);
      const evt = await repo.createEvent({
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
    it("returns null for nonexistent event", async () => {
      expect(await repo.getEvent("nonexistent")).toBeNull();
    });

    it("returns the event after creation", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 2 });
      const evt = await repo.getEvent("evt-1");
      expect(evt).not.toBeNull();
      expect(evt?.id).toBe("evt-1");
      expect(evt?.tenantsTotal).toBe(2);
    });
  });

  describe("updateEvent", () => {
    it("updates event fields and returns updated event", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 3 });
      const updated = await repo.updateEvent("evt-1", {
        status: "completed",
        tenantsRecovered: 3,
        completedAt: Math.floor(Date.now() / 1000),
      });
      expect(updated.status).toBe("completed");
      expect(updated.tenantsRecovered).toBe(3);
      expect(updated.completedAt).not.toBeNull();
    });

    it("partial update does not reset other fields", async () => {
      await repo.createEvent({
        id: "evt-1",
        nodeId: "node-1",
        trigger: "heartbeat_timeout",
        tenantsTotal: 5,
      });
      await repo.updateEvent("evt-1", { tenantsRecovered: 2 });
      const evt = await repo.getEvent("evt-1");
      expect(evt?.tenantsTotal).toBe(5);
      expect(evt?.tenantsRecovered).toBe(2);
      expect(evt?.status).toBe("in_progress");
    });
  });

  describe("createItem", () => {
    it("creates an item with waiting status and retryCount 0", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      const item = await repo.createItem({
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
    it("updates item status and target node", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      await repo.createItem({
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "tenant-a",
        sourceNode: "node-1",
        backupKey: "key",
      });
      const updated = await repo.updateItem("item-1", {
        status: "recovered",
        targetNode: "node-2",
        completedAt: Math.floor(Date.now() / 1000),
      });
      expect(updated.status).toBe("recovered");
      expect(updated.targetNode).toBe("node-2");
      expect(updated.completedAt).not.toBeNull();
    });

    it("can set a failure reason", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      await repo.createItem({
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "tenant-a",
        sourceNode: "node-1",
        backupKey: "key",
      });
      const updated = await repo.updateItem("item-1", {
        status: "failed",
        reason: "no_capacity",
      });
      expect(updated.status).toBe("failed");
      expect(updated.reason).toBe("no_capacity");
    });
  });

  describe("listOpenEvents", () => {
    it("returns events with in_progress status", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      const open = await repo.listOpenEvents();
      expect(open).toHaveLength(1);
      expect(open[0].id).toBe("evt-1");
      expect(open[0].status).toBe("in_progress");
    });

    it("returns events with partial status", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 3 });
      await repo.updateEvent("evt-1", { status: "partial", tenantsWaiting: 1 });
      const open = await repo.listOpenEvents();
      expect(open).toHaveLength(1);
      expect(open[0].status).toBe("partial");
    });

    it("does NOT return completed events", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      await repo.updateEvent("evt-1", {
        status: "completed",
        completedAt: Math.floor(Date.now() / 1000),
      });
      const open = await repo.listOpenEvents();
      expect(open).toHaveLength(0);
    });

    it("returns multiple open events from different nodes", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      await repo.createEvent({
        id: "evt-2",
        nodeId: "node-2",
        trigger: "heartbeat_timeout",
        tenantsTotal: 2,
      });
      await repo.createEvent({ id: "evt-3", nodeId: "node-3", trigger: "manual", tenantsTotal: 1 });
      await repo.updateEvent("evt-3", { status: "completed" });
      const open = await repo.listOpenEvents();
      expect(open).toHaveLength(2);
      const ids = open.map((e) => e.id).sort();
      expect(ids).toEqual(["evt-1", "evt-2"]);
    });

    it("returns empty array when no events exist", async () => {
      expect(await repo.listOpenEvents()).toEqual([]);
    });
  });

  describe("listEvents", () => {
    it("returns all events regardless of status", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      await repo.createEvent({ id: "evt-2", nodeId: "node-2", trigger: "heartbeat_timeout", tenantsTotal: 2 });
      await repo.updateEvent("evt-2", { status: "completed", completedAt: Math.floor(Date.now() / 1000) });
      const all = await repo.listEvents(50);
      expect(all).toHaveLength(2);
      const ids = all.map((e) => e.id).sort();
      expect(ids).toEqual(["evt-1", "evt-2"]);
    });

    it("returns completed events that listOpenEvents hides", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      await repo.updateEvent("evt-1", { status: "completed", completedAt: Math.floor(Date.now() / 1000) });
      const open = await repo.listOpenEvents();
      expect(open).toHaveLength(0);
      const all = await repo.listEvents(50);
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe("completed");
    });

    it("respects the limit", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      await repo.createEvent({ id: "evt-2", nodeId: "node-2", trigger: "manual", tenantsTotal: 1 });
      await repo.createEvent({ id: "evt-3", nodeId: "node-3", trigger: "manual", tenantsTotal: 1 });
      const limited = await repo.listEvents(2);
      expect(limited).toHaveLength(2);
    });

    it("filters by status when provided", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      await repo.createEvent({ id: "evt-2", nodeId: "node-2", trigger: "manual", tenantsTotal: 1 });
      await repo.updateEvent("evt-2", { status: "completed", completedAt: Math.floor(Date.now() / 1000) });
      const completed = await repo.listEvents(50, "completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe("evt-2");
      const inProgress = await repo.listEvents(50, "in_progress");
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0].id).toBe("evt-1");
    });

    it("returns empty array when no events exist", async () => {
      expect(await repo.listEvents(50)).toEqual([]);
    });
  });

  describe("getWaitingItems", () => {
    it("returns only items with waiting status for given event", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 3 });
      await repo.createItem({
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "t-a",
        sourceNode: "node-1",
        backupKey: "k1",
      });
      await repo.createItem({
        id: "item-2",
        recoveryEventId: "evt-1",
        tenant: "t-b",
        sourceNode: "node-1",
        backupKey: "k2",
      });
      await repo.createItem({
        id: "item-3",
        recoveryEventId: "evt-1",
        tenant: "t-c",
        sourceNode: "node-1",
        backupKey: "k3",
      });
      await repo.updateItem("item-1", { status: "recovered", targetNode: "node-2" });
      const waiting = await repo.getWaitingItems("evt-1");
      expect(waiting).toHaveLength(2);
      expect(waiting.every((i) => i.status === "waiting")).toBe(true);
    });

    it("returns empty array when no waiting items", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      await repo.createItem({
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "t-a",
        sourceNode: "node-1",
        backupKey: "k1",
      });
      await repo.updateItem("item-1", { status: "recovered", targetNode: "node-2" });
      expect(await repo.getWaitingItems("evt-1")).toEqual([]);
    });

    it("does not return items from a different event", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      await repo.createEvent({ id: "evt-2", nodeId: "node-2", trigger: "manual", tenantsTotal: 1 });
      await repo.createItem({
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "t-a",
        sourceNode: "node-1",
        backupKey: "k1",
      });
      await repo.createItem({
        id: "item-2",
        recoveryEventId: "evt-2",
        tenant: "t-b",
        sourceNode: "node-2",
        backupKey: "k2",
      });
      const waiting = await repo.getWaitingItems("evt-1");
      expect(waiting).toHaveLength(1);
      expect(waiting[0].tenant).toBe("t-a");
    });
  });

  describe("incrementRetryCount", () => {
    it("increments retryCount atomically by 1", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 1 });
      await repo.createItem({
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "t-a",
        sourceNode: "node-1",
        backupKey: "k1",
      });
      expect((await repo.getWaitingItems("evt-1"))[0].retryCount).toBe(0);
      await repo.incrementRetryCount("item-1");
      expect((await repo.getWaitingItems("evt-1"))[0].retryCount).toBe(1);
      await repo.incrementRetryCount("item-1");
      expect((await repo.getWaitingItems("evt-1"))[0].retryCount).toBe(2);
    });

    it("only increments the targeted item", async () => {
      await repo.createEvent({ id: "evt-1", nodeId: "node-1", trigger: "manual", tenantsTotal: 2 });
      await repo.createItem({
        id: "item-1",
        recoveryEventId: "evt-1",
        tenant: "t-a",
        sourceNode: "node-1",
        backupKey: "k1",
      });
      await repo.createItem({
        id: "item-2",
        recoveryEventId: "evt-1",
        tenant: "t-b",
        sourceNode: "node-1",
        backupKey: "k2",
      });
      await repo.incrementRetryCount("item-1");
      await repo.incrementRetryCount("item-1");
      await repo.incrementRetryCount("item-1");
      const items = await repo.getWaitingItems("evt-1");
      const item1 = items.find((i) => i.id === "item-1");
      const item2 = items.find((i) => i.id === "item-2");
      expect(item1?.retryCount).toBe(3);
      expect(item2?.retryCount).toBe(0);
    });
  });
});
