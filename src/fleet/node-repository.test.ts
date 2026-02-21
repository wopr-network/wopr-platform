import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { nodes } from "../db/schema/index.js";
import { nodeTransitions } from "../db/schema/node-transitions.js";
import { DrizzleNodeRepository } from "./node-repository.js";
import { ConcurrentTransitionError, InvalidTransitionError, NodeNotFoundError } from "./node-state-machine.js";

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

  sqlite.exec("CREATE INDEX idx_nodes_status ON nodes (status)");

  return { db, sqlite };
}

function insertNode(
  db: ReturnType<typeof setupDb>["db"],
  overrides: Partial<typeof nodes.$inferInsert> & { id: string },
) {
  db.insert(nodes)
    .values({
      host: "10.0.0.1",
      capacityMb: 1000,
      usedMb: 0,
      registeredAt: 1,
      updatedAt: 1,
      ...overrides,
    })
    .run();
}

describe("DrizzleNodeRepository — transition()", () => {
  let db: ReturnType<typeof setupDb>["db"];
  let sqlite: Database.Database;
  let repo: DrizzleNodeRepository;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
    repo = new DrizzleNodeRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns node with new status on success", () => {
    insertNode(db, { id: "node-1", status: "active" });
    const result = repo.transition("node-1", "unhealthy", "heartbeat_timeout", "heartbeat_watchdog");
    expect(result.status).toBe("unhealthy");
    expect(result.id).toBe("node-1");
  });

  it("creates audit trail in node_transitions", () => {
    insertNode(db, { id: "node-1", status: "active" });
    repo.transition("node-1", "unhealthy", "heartbeat_timeout", "heartbeat_watchdog");
    const transitions = repo.listTransitions("node-1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0].fromStatus).toBe("active");
    expect(transitions[0].toStatus).toBe("unhealthy");
    expect(transitions[0].reason).toBe("heartbeat_timeout");
    expect(transitions[0].triggeredBy).toBe("heartbeat_watchdog");
  });

  it("throws InvalidTransitionError for invalid transition", () => {
    insertNode(db, { id: "node-1", status: "active" });
    // active → offline is not a valid transition (must go through unhealthy first)
    expect(() => repo.transition("node-1", "offline", "test", "test")).toThrow(InvalidTransitionError);
  });

  it("throws NodeNotFoundError when node doesn't exist", () => {
    expect(() => repo.transition("nonexistent", "active", "test", "test")).toThrow(NodeNotFoundError);
  });

  it("throws ConcurrentTransitionError when CAS fails (changes === 0)", () => {
    insertNode(db, { id: "node-1", status: "active" });

    // Subclass overrides getById to simulate a concurrent modification:
    // after we read 'active', another process changes status to 'draining',
    // so the CAS WHERE (id=node-1 AND status='active') finds 0 rows.
    class RacyRepo extends DrizzleNodeRepository {
      private raceOnce = true;
      override getById(id: string) {
        const result = super.getById(id);
        if (result && this.raceOnce) {
          this.raceOnce = false;
          // Simulate concurrent write: change status out from under the CAS
          sqlite.exec(`UPDATE nodes SET status = 'draining' WHERE id = '${id}'`);
        }
        return result;
      }
    }

    const racyRepo = new RacyRepo(db);
    // active → unhealthy is valid per state machine, but CAS will fail because
    // status is now 'draining' in DB when the WHERE clause executes
    expect(() => racyRepo.transition("node-1", "unhealthy", "test_race", "test")).toThrow(ConcurrentTransitionError);
  });

  it("does not create transition entry when throwing InvalidTransitionError", () => {
    insertNode(db, { id: "node-1", status: "active" });
    expect(() => repo.transition("node-1", "offline", "bad", "bad")).toThrow(InvalidTransitionError);
    const transitions = repo.listTransitions("node-1");
    expect(transitions).toHaveLength(0);
  });
});

describe("DrizzleNodeRepository — register()", () => {
  let db: ReturnType<typeof setupDb>["db"];
  let sqlite: Database.Database;
  let repo: DrizzleNodeRepository;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
    repo = new DrizzleNodeRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("registers new node with provisioning -> active audit trail", () => {
    const result = repo.register({
      nodeId: "node-new",
      host: "10.0.0.5",
      capacityMb: 2000,
      agentVersion: "1.0.0",
    });
    expect(result.status).toBe("active");
    expect(result.id).toBe("node-new");

    const transitions = repo.listTransitions("node-new");
    expect(transitions).toHaveLength(1);
    expect(transitions[0].fromStatus).toBe("provisioning");
    expect(transitions[0].toStatus).toBe("active");
    expect(transitions[0].reason).toBe("first_registration");
  });

  it("transitions offline node to returning", () => {
    insertNode(db, { id: "node-1", status: "offline" });
    const result = repo.register({
      nodeId: "node-1",
      host: "10.0.0.1",
      capacityMb: 1000,
      agentVersion: "2.0.0",
    });
    expect(result.status).toBe("returning");
  });

  it("transitions recovering node to returning", () => {
    insertNode(db, { id: "node-1", status: "recovering" });
    const result = repo.register({
      nodeId: "node-1",
      host: "10.0.0.1",
      capacityMb: 1000,
      agentVersion: "2.0.0",
    });
    expect(result.status).toBe("returning");
  });

  it("transitions failed node to returning", () => {
    insertNode(db, { id: "node-1", status: "failed" });
    const result = repo.register({
      nodeId: "node-1",
      host: "10.0.0.1",
      capacityMb: 1000,
      agentVersion: "2.0.0",
    });
    expect(result.status).toBe("returning");
  });

  it("does NOT transition a healthy active node", () => {
    insertNode(db, { id: "node-1", status: "active", host: "10.0.0.1" });
    const result = repo.register({
      nodeId: "node-1",
      host: "10.0.0.2",
      capacityMb: 1000,
      agentVersion: "2.0.0",
    });
    expect(result.status).toBe("active");

    const transitions = repo.listTransitions("node-1");
    expect(transitions).toHaveLength(0);

    const node = repo.getById("node-1");
    expect(node?.host).toBe("10.0.0.2");
    expect(node?.agentVersion).toBe("2.0.0");
  });

  it("does NOT transition a healthy unhealthy node (still healthy, not dead)", () => {
    insertNode(db, { id: "node-1", status: "unhealthy" });
    const result = repo.register({
      nodeId: "node-1",
      host: "10.0.0.1",
      capacityMb: 1000,
      agentVersion: "2.0.0",
    });
    expect(result.status).toBe("unhealthy");
    expect(repo.listTransitions("node-1")).toHaveLength(0);
  });
});

describe("DrizzleNodeRepository — other methods", () => {
  let db: ReturnType<typeof setupDb>["db"];
  let sqlite: Database.Database;
  let repo: DrizzleNodeRepository;

  beforeEach(() => {
    ({ db, sqlite } = setupDb());
    repo = new DrizzleNodeRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("getById returns null for nonexistent node", () => {
    expect(repo.getById("nope")).toBeNull();
  });

  it("getById returns the node when it exists", () => {
    insertNode(db, { id: "node-1", status: "active" });
    const node = repo.getById("node-1");
    expect(node).not.toBeNull();
    expect(node?.id).toBe("node-1");
  });

  it("list returns all nodes when no statuses provided", () => {
    insertNode(db, { id: "node-1", status: "active" });
    insertNode(db, { id: "node-2", status: "offline" });
    const all = repo.list();
    expect(all).toHaveLength(2);
  });

  it("list filters by status", () => {
    insertNode(db, { id: "node-1", status: "active" });
    insertNode(db, { id: "node-2", status: "offline" });
    insertNode(db, { id: "node-3", status: "active" });
    const active = repo.list(["active"]);
    expect(active).toHaveLength(2);
    expect(active.every((n) => n.status === "active")).toBe(true);
  });

  it("list with multiple statuses returns matching nodes", () => {
    insertNode(db, { id: "node-1", status: "active" });
    insertNode(db, { id: "node-2", status: "offline" });
    insertNode(db, { id: "node-3", status: "recovering" });
    const results = repo.list(["offline", "recovering"]);
    expect(results).toHaveLength(2);
  });

  it("updateHeartbeat updates lastHeartbeatAt and usedMb", () => {
    insertNode(db, { id: "node-1", status: "active", usedMb: 100 });
    repo.updateHeartbeat("node-1", 500);
    const node = repo.getById("node-1");
    expect(node?.usedMb).toBe(500);
    expect(node?.lastHeartbeatAt).not.toBeNull();
  });

  it("addCapacity adjusts usedMb by positive delta", () => {
    insertNode(db, { id: "node-1", status: "active", usedMb: 200 });
    repo.addCapacity("node-1", 300);
    const node = repo.getById("node-1");
    expect(node?.usedMb).toBe(500);
  });

  it("addCapacity adjusts usedMb by negative delta", () => {
    insertNode(db, { id: "node-1", status: "active", usedMb: 500 });
    repo.addCapacity("node-1", -200);
    const node = repo.getById("node-1");
    expect(node?.usedMb).toBe(300);
  });

  it("findBestTarget returns node with most free capacity excluding given node", () => {
    insertNode(db, { id: "node-1", status: "active", capacityMb: 2000, usedMb: 500 }); // 1500 free
    insertNode(db, { id: "node-2", status: "active", capacityMb: 1000, usedMb: 100 }); // 900 free
    insertNode(db, { id: "node-3", status: "active", capacityMb: 3000, usedMb: 1000 }); // 2000 free — but excluded
    const result = repo.findBestTarget("node-3", 100);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("node-1"); // most free after exclusion
  });

  it("findBestTarget returns null when no node has enough capacity", () => {
    insertNode(db, { id: "node-1", status: "active", capacityMb: 1000, usedMb: 950 });
    const result = repo.findBestTarget("node-x", 200);
    expect(result).toBeNull();
  });

  it("findBestTarget excludes non-active nodes", () => {
    insertNode(db, { id: "node-1", status: "offline", capacityMb: 5000, usedMb: 0 });
    insertNode(db, { id: "node-2", status: "active", capacityMb: 1000, usedMb: 0 });
    const result = repo.findBestTarget("node-x", 100);
    expect(result?.id).toBe("node-2");
  });

  it("listTransitions returns transitions in descending order by createdAt", () => {
    insertNode(db, { id: "node-1", status: "active" });
    // Insert transitions directly to control createdAt
    db.insert(nodeTransitions)
      .values([
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
      ])
      .run();
    const transitions = repo.listTransitions("node-1");
    expect(transitions[0].createdAt).toBe(300);
    expect(transitions[1].createdAt).toBe(200);
    expect(transitions[2].createdAt).toBe(100);
  });

  it("listTransitions respects limit parameter", () => {
    insertNode(db, { id: "node-1", status: "active" });
    db.insert(nodeTransitions)
      .values([
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
      ])
      .run();
    const transitions = repo.listTransitions("node-1", 2);
    expect(transitions).toHaveLength(2);
  });
});
