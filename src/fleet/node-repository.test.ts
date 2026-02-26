import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { nodes } from "../db/schema/index.js";
import { nodeTransitions } from "../db/schema/node-transitions.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleNodeRepository } from "./drizzle-node-repository.js";
import { ConcurrentTransitionError, InvalidTransitionError, NodeNotFoundError } from "./node-state-machine.js";

async function insertNode(db: DrizzleDb, overrides: Partial<typeof nodes.$inferInsert> & { id: string }) {
  await db.insert(nodes).values({
    host: "10.0.0.1",
    capacityMb: 1000,
    usedMb: 0,
    registeredAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

describe("DrizzleNodeRepository — transition()", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleNodeRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleNodeRepository(db);
  });

  it("returns node with new status on success", async () => {
    await insertNode(db, { id: "node-1", status: "active" });
    const result = await repo.transition("node-1", "unhealthy", "heartbeat_timeout", "heartbeat_watchdog");
    expect(result.status).toBe("unhealthy");
    expect(result.id).toBe("node-1");
  });

  it("creates audit trail in node_transitions", async () => {
    await insertNode(db, { id: "node-1", status: "active" });
    await repo.transition("node-1", "unhealthy", "heartbeat_timeout", "heartbeat_watchdog");
    const transitions = await repo.listTransitions("node-1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0].fromStatus).toBe("active");
    expect(transitions[0].toStatus).toBe("unhealthy");
    expect(transitions[0].reason).toBe("heartbeat_timeout");
    expect(transitions[0].triggeredBy).toBe("heartbeat_watchdog");
  });

  it("throws InvalidTransitionError for invalid transition", async () => {
    await insertNode(db, { id: "node-1", status: "active" });
    // active → offline is not a valid transition (must go through unhealthy first)
    await expect(repo.transition("node-1", "offline", "test", "test")).rejects.toThrow(InvalidTransitionError);
  });

  it("throws NodeNotFoundError when node doesn't exist", async () => {
    await expect(repo.transition("nonexistent", "active", "test", "test")).rejects.toThrow(NodeNotFoundError);
  });

  it("throws ConcurrentTransitionError when CAS fails (changes === 0)", async () => {
    await insertNode(db, { id: "node-1", status: "active" });

    // Subclass overrides getById to simulate a concurrent modification:
    // after we read 'active', another process changes status to 'draining',
    // so the CAS WHERE (id=node-1 AND status='active') finds 0 rows.
    class RacyRepo extends DrizzleNodeRepository {
      private raceOnce = true;
      override async getById(id: string) {
        const result = await super.getById(id);
        if (result && this.raceOnce) {
          this.raceOnce = false;
          // Simulate concurrent write: change status out from under the CAS
          const { eq: eqFn } = await import("drizzle-orm");
          await db.update(nodes).set({ status: "draining" }).where(eqFn(nodes.id, id));
        }
        return result;
      }
    }

    const racyRepo = new RacyRepo(db);
    // active → unhealthy is valid per state machine, but CAS will fail because
    // status is now 'draining' in DB when the WHERE clause executes
    await expect(racyRepo.transition("node-1", "unhealthy", "test_race", "test")).rejects.toThrow(
      ConcurrentTransitionError,
    );
  });

  it("does not create transition entry when throwing InvalidTransitionError", async () => {
    await insertNode(db, { id: "node-1", status: "active" });
    await expect(repo.transition("node-1", "offline", "bad", "bad")).rejects.toThrow(InvalidTransitionError);
    const transitions = await repo.listTransitions("node-1");
    expect(transitions).toHaveLength(0);
  });

  it("clears drainStatus, drainMigrated, drainTotal when transitioning draining → active (cancel-drain)", async () => {
    await insertNode(db, {
      id: "node-1",
      status: "draining",
      drainStatus: "draining",
      drainMigrated: 3,
      drainTotal: 10,
    });

    const result = await repo.transition("node-1", "active", "drain_cancelled", "admin");

    expect(result.status).toBe("active");
    expect(result.drainStatus).toBeNull();
    expect(result.drainMigrated).toBeNull();
    expect(result.drainTotal).toBeNull();

    // Verify persisted to DB
    const persisted = await repo.getById("node-1");
    expect(persisted?.drainStatus).toBeNull();
    expect(persisted?.drainMigrated).toBeNull();
    expect(persisted?.drainTotal).toBeNull();
  });

  it("does not clear drain metadata on other transitions", async () => {
    await insertNode(db, {
      id: "node-1",
      status: "active",
      drainStatus: "drained",
      drainMigrated: 5,
      drainTotal: 5,
    });

    const result = await repo.transition("node-1", "unhealthy", "heartbeat_timeout", "heartbeat_watchdog");

    // Drain metadata should be untouched on non-cancel-drain transitions
    expect(result.status).toBe("unhealthy");
    const persisted = await repo.getById("node-1");
    expect(persisted?.drainStatus).toBe("drained");
    expect(persisted?.drainMigrated).toBe(5);
    expect(persisted?.drainTotal).toBe(5);
  });
});

describe("DrizzleNodeRepository — register()", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleNodeRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleNodeRepository(db);
  });

  it("registers new node with provisioning -> active audit trail", async () => {
    const result = await repo.register({
      nodeId: "node-new",
      host: "10.0.0.5",
      capacityMb: 2000,
      agentVersion: "1.0.0",
    });
    expect(result.status).toBe("active");
    expect(result.id).toBe("node-new");

    const transitions = await repo.listTransitions("node-new");
    expect(transitions).toHaveLength(1);
    expect(transitions[0].fromStatus).toBe("provisioning");
    expect(transitions[0].toStatus).toBe("active");
    expect(transitions[0].reason).toBe("first_registration");
  });

  it("transitions offline node to returning", async () => {
    await insertNode(db, { id: "node-1", status: "offline" });
    const result = await repo.register({
      nodeId: "node-1",
      host: "10.0.0.1",
      capacityMb: 1000,
      agentVersion: "2.0.0",
    });
    expect(result.status).toBe("returning");
  });

  it("transitions recovering node to returning", async () => {
    await insertNode(db, { id: "node-1", status: "recovering" });
    const result = await repo.register({
      nodeId: "node-1",
      host: "10.0.0.1",
      capacityMb: 1000,
      agentVersion: "2.0.0",
    });
    expect(result.status).toBe("returning");
  });

  it("transitions failed node to returning", async () => {
    await insertNode(db, { id: "node-1", status: "failed" });
    const result = await repo.register({
      nodeId: "node-1",
      host: "10.0.0.1",
      capacityMb: 1000,
      agentVersion: "2.0.0",
    });
    expect(result.status).toBe("returning");
  });

  it("does NOT transition a healthy active node", async () => {
    await insertNode(db, { id: "node-1", status: "active", host: "10.0.0.1" });
    const result = await repo.register({
      nodeId: "node-1",
      host: "10.0.0.2",
      capacityMb: 1000,
      agentVersion: "2.0.0",
    });
    expect(result.status).toBe("active");

    const transitions = await repo.listTransitions("node-1");
    expect(transitions).toHaveLength(0);

    const node = await repo.getById("node-1");
    expect(node?.host).toBe("10.0.0.2");
    expect(node?.agentVersion).toBe("2.0.0");
  });

  it("does NOT transition a healthy unhealthy node (still healthy, not dead)", async () => {
    await insertNode(db, { id: "node-1", status: "unhealthy" });
    const result = await repo.register({
      nodeId: "node-1",
      host: "10.0.0.1",
      capacityMb: 1000,
      agentVersion: "2.0.0",
    });
    expect(result.status).toBe("unhealthy");
    expect(await repo.listTransitions("node-1")).toHaveLength(0);
  });
});

describe("DrizzleNodeRepository — other methods", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleNodeRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleNodeRepository(db);
  });

  it("getById returns null for nonexistent node", async () => {
    expect(await repo.getById("nope")).toBeNull();
  });

  it("getById returns the node when it exists", async () => {
    await insertNode(db, { id: "node-1", status: "active" });
    const node = await repo.getById("node-1");
    expect(node).not.toBeNull();
    expect(node?.id).toBe("node-1");
  });

  it("list returns all nodes when no statuses provided", async () => {
    await insertNode(db, { id: "node-1", status: "active" });
    await insertNode(db, { id: "node-2", status: "offline" });
    const all = await repo.list();
    expect(all).toHaveLength(2);
  });

  it("list filters by status", async () => {
    await insertNode(db, { id: "node-1", status: "active" });
    await insertNode(db, { id: "node-2", status: "offline" });
    await insertNode(db, { id: "node-3", status: "active" });
    const active = await repo.list(["active"]);
    expect(active).toHaveLength(2);
    expect(active.every((n) => n.status === "active")).toBe(true);
  });

  it("list with multiple statuses returns matching nodes", async () => {
    await insertNode(db, { id: "node-1", status: "active" });
    await insertNode(db, { id: "node-2", status: "offline" });
    await insertNode(db, { id: "node-3", status: "recovering" });
    const results = await repo.list(["offline", "recovering"]);
    expect(results).toHaveLength(2);
  });

  it("updateHeartbeat updates lastHeartbeatAt and usedMb", async () => {
    await insertNode(db, { id: "node-1", status: "active", usedMb: 100 });
    await repo.updateHeartbeat("node-1", 500);
    const node = await repo.getById("node-1");
    expect(node?.usedMb).toBe(500);
    expect(node?.lastHeartbeatAt).not.toBeNull();
  });

  it("addCapacity adjusts usedMb by positive delta", async () => {
    await insertNode(db, { id: "node-1", status: "active", usedMb: 200 });
    await repo.addCapacity("node-1", 300);
    const node = await repo.getById("node-1");
    expect(node?.usedMb).toBe(500);
  });

  it("addCapacity adjusts usedMb by negative delta", async () => {
    await insertNode(db, { id: "node-1", status: "active", usedMb: 500 });
    await repo.addCapacity("node-1", -200);
    const node = await repo.getById("node-1");
    expect(node?.usedMb).toBe(300);
  });

  it("findBestTarget returns node with most free capacity excluding given node", async () => {
    await insertNode(db, { id: "node-1", status: "active", capacityMb: 2000, usedMb: 500 }); // 1500 free
    await insertNode(db, { id: "node-2", status: "active", capacityMb: 1000, usedMb: 100 }); // 900 free
    await insertNode(db, { id: "node-3", status: "active", capacityMb: 3000, usedMb: 1000 }); // 2000 free — but excluded
    const result = await repo.findBestTarget("node-3", 100);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("node-1"); // most free after exclusion
  });

  it("findBestTarget returns null when no node has enough capacity", async () => {
    await insertNode(db, { id: "node-1", status: "active", capacityMb: 1000, usedMb: 950 });
    const result = await repo.findBestTarget("node-x", 200);
    expect(result).toBeNull();
  });

  it("findBestTarget excludes non-active nodes", async () => {
    await insertNode(db, { id: "node-1", status: "offline", capacityMb: 5000, usedMb: 0 });
    await insertNode(db, { id: "node-2", status: "active", capacityMb: 1000, usedMb: 0 });
    const result = await repo.findBestTarget("node-x", 100);
    expect(result?.id).toBe("node-2");
  });

  it("listTransitions returns transitions in descending order by createdAt", async () => {
    await insertNode(db, { id: "node-1", status: "active" });
    // Insert transitions directly to control createdAt
    await db.insert(nodeTransitions).values([
      {
        id: "t1",
        nodeId: "node-1",
        fromStatus: "provisioning",
        toStatus: "active",
        reason: "r1",
        triggeredBy: "sys",
        createdAt: 100,
      },
      {
        id: "t2",
        nodeId: "node-1",
        fromStatus: "active",
        toStatus: "unhealthy",
        reason: "r2",
        triggeredBy: "sys",
        createdAt: 200,
      },
      {
        id: "t3",
        nodeId: "node-1",
        fromStatus: "unhealthy",
        toStatus: "active",
        reason: "r3",
        triggeredBy: "sys",
        createdAt: 300,
      },
    ]);
    const transitions = await repo.listTransitions("node-1");
    expect(transitions[0].createdAt).toBe(300);
    expect(transitions[1].createdAt).toBe(200);
    expect(transitions[2].createdAt).toBe(100);
  });

  it("listTransitions respects limit parameter", async () => {
    await insertNode(db, { id: "node-1", status: "active" });
    await db.insert(nodeTransitions).values([
      {
        id: "t1",
        nodeId: "node-1",
        fromStatus: "provisioning",
        toStatus: "active",
        reason: "r1",
        triggeredBy: "sys",
        createdAt: 100,
      },
      {
        id: "t2",
        nodeId: "node-1",
        fromStatus: "active",
        toStatus: "unhealthy",
        reason: "r2",
        triggeredBy: "sys",
        createdAt: 200,
      },
      {
        id: "t3",
        nodeId: "node-1",
        fromStatus: "unhealthy",
        toStatus: "active",
        reason: "r3",
        triggeredBy: "sys",
        createdAt: 300,
      },
    ]);
    const transitions = await repo.listTransitions("node-1", 2);
    expect(transitions).toHaveLength(2);
  });
});
