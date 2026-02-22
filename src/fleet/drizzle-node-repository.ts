import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { nodeTransitions } from "../db/schema/node-transitions.js";
import { nodes } from "../db/schema/nodes.js";
import type { INodeRepository } from "./node-repository.js";
import {
  ConcurrentTransitionError,
  InvalidTransitionError,
  isValidTransition,
  NodeNotFoundError,
  type NodeStatus,
} from "./node-state-machine.js";
import type { Node, NodeRegistration, NodeTransition, SelfHostedNodeRegistration } from "./repository-types.js";

type NodeRow = typeof nodes.$inferSelect;
type TransitionRow = typeof nodeTransitions.$inferSelect;

function toNode(row: NodeRow): Node {
  return row as unknown as Node;
}

function toNodeTransition(row: TransitionRow): NodeTransition {
  return row as unknown as NodeTransition;
}

export class DrizzleNodeRepository implements INodeRepository {
  constructor(private readonly db: DrizzleDb) {}

  getById(id: string): Node | null {
    const row = this.db.select().from(nodes).where(eq(nodes.id, id)).get() ?? null;
    return row ? toNode(row) : null;
  }

  getBySecret(secret: string): Node | null {
    const hash = createHash("sha256").update(secret).digest("hex");
    const row = this.db.select().from(nodes).where(eq(nodes.nodeSecret, hash)).get() ?? null;
    return row ? toNode(row) : null;
  }

  list(statuses?: NodeStatus[]): Node[] {
    if (statuses && statuses.length > 0) {
      return this.db.select().from(nodes).where(inArray(nodes.status, statuses)).all().map(toNode);
    }
    return this.db.select().from(nodes).all().map(toNode);
  }

  transition(id: string, to: NodeStatus, reason: string, triggeredBy: string): Node {
    const now = Math.floor(Date.now() / 1000);

    return this.db.transaction(() => {
      const node = this.getById(id);
      if (!node) throw new NodeNotFoundError(id);

      if (!isValidTransition(node.status, to)) {
        throw new InvalidTransitionError(node.status, to);
      }

      const result = this.db
        .update(nodes)
        .set({ status: to, updatedAt: now })
        .where(and(eq(nodes.id, id), eq(nodes.status, node.status)))
        .run();

      if (result.changes === 0) {
        throw new ConcurrentTransitionError(id);
      }

      this.db
        .insert(nodeTransitions)
        .values({
          id: randomUUID(),
          nodeId: id,
          fromStatus: node.status,
          toStatus: to,
          reason,
          triggeredBy,
          createdAt: now,
        })
        .run();

      return { ...node, status: to, updatedAt: now };
    });
  }

  register(data: NodeRegistration): Node {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.db.select().from(nodes).where(eq(nodes.id, data.nodeId)).get() ?? null;

    if (!existing) {
      return this.db.transaction(() => {
        this.db
          .insert(nodes)
          .values({
            id: data.nodeId,
            host: data.host,
            capacityMb: data.capacityMb,
            usedMb: 0,
            agentVersion: data.agentVersion,
            status: "provisioning",
            lastHeartbeatAt: now,
            registeredAt: now,
            updatedAt: now,
          })
          .run();

        return this.transition(data.nodeId, "active", "first_registration", "node_agent");
      });
    }

    const deadStates: NodeStatus[] = ["offline", "recovering", "failed"];
    if (deadStates.includes(existing.status as NodeStatus)) {
      return this.db.transaction(() => {
        this.db
          .update(nodes)
          .set({
            host: data.host,
            agentVersion: data.agentVersion,
            updatedAt: now,
          })
          .where(eq(nodes.id, data.nodeId))
          .run();

        return this.transition(data.nodeId, "returning", "re_registration", "node_agent");
      });
    }

    // Healthy node re-registering — metadata update only, no transition
    const row = this.db
      .update(nodes)
      .set({
        host: data.host,
        agentVersion: data.agentVersion,
        updatedAt: now,
      })
      .where(eq(nodes.id, data.nodeId))
      .returning()
      .get();
    return toNode(row);
  }

  registerSelfHosted(data: SelfHostedNodeRegistration): Node {
    const now = Math.floor(Date.now() / 1000);
    return this.db.transaction(() => {
      this.db
        .insert(nodes)
        .values({
          id: data.nodeId,
          host: data.host,
          capacityMb: data.capacityMb,
          usedMb: 0,
          agentVersion: data.agentVersion,
          status: "provisioning",
          lastHeartbeatAt: now,
          registeredAt: now,
          updatedAt: now,
          ownerUserId: data.ownerUserId,
          label: data.label,
          nodeSecret: data.nodeSecretHash,
        })
        .run();

      return this.transition(data.nodeId, "active", "first_registration", "node_agent");
    });
  }

  updateHeartbeat(id: string, usedMb: number): void {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .update(nodes)
      .set({ lastHeartbeatAt: now, usedMb, updatedAt: now })
      .where(eq(nodes.id, id))
      .run();
    if (result.changes === 0) throw new NodeNotFoundError(id);
  }

  addCapacity(id: string, deltaMb: number): void {
    const result = this.db
      .update(nodes)
      .set({ usedMb: sql`MAX(0, ${nodes.usedMb} + ${deltaMb})` })
      .where(eq(nodes.id, id))
      .run();
    if (result.changes === 0) throw new NodeNotFoundError(id);
  }

  findBestTarget(excludeId: string, requiredMb: number): Node | null {
    const row =
      this.db
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.status, "active"),
            ne(nodes.id, excludeId),
            sql`(${nodes.capacityMb} - ${nodes.usedMb}) >= ${requiredMb}`,
          ),
        )
        .orderBy(desc(sql`${nodes.capacityMb} - ${nodes.usedMb}`))
        .limit(1)
        .get() ?? null;
    return row ? toNode(row) : null;
  }

  listTransitions(nodeId: string, limit = 50): NodeTransition[] {
    return this.db
      .select()
      .from(nodeTransitions)
      .where(eq(nodeTransitions.nodeId, nodeId))
      .orderBy(desc(nodeTransitions.createdAt))
      .limit(limit)
      .all()
      .map(toNodeTransition);
  }
}
