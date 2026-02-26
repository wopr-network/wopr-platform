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

  async getById(id: string): Promise<Node | null> {
    const rows = await this.db.select().from(nodes).where(eq(nodes.id, id));
    return rows[0] ? toNode(rows[0]) : null;
  }

  async getBySecret(secret: string): Promise<Node | null> {
    const hash = createHash("sha256").update(secret).digest("hex");
    const rows = await this.db.select().from(nodes).where(eq(nodes.nodeSecret, hash));
    return rows[0] ? toNode(rows[0]) : null;
  }

  async list(statuses?: NodeStatus[]): Promise<Node[]> {
    if (statuses && statuses.length > 0) {
      const rows = await this.db.select().from(nodes).where(inArray(nodes.status, statuses));
      return rows.map(toNode);
    }
    const rows = await this.db.select().from(nodes);
    return rows.map(toNode);
  }

  async transition(id: string, to: NodeStatus, reason: string, triggeredBy: string): Promise<Node> {
    const now = Math.floor(Date.now() / 1000);

    // Read node before transaction (allows subclass override for testing)
    const node = await this.getById(id);
    if (!node) throw new NodeNotFoundError(id);

    if (!isValidTransition(node.status, to)) {
      throw new InvalidTransitionError(node.status, to);
    }

    const fromStatus = node.status;
    const extraFields =
      fromStatus === "draining" && to === "active" ? { drainStatus: null, drainMigrated: null, drainTotal: null } : {};

    return this.db.transaction(async (tx) => {
      const result = await tx
        .update(nodes)
        .set({ status: to, updatedAt: now, ...extraFields })
        .where(and(eq(nodes.id, id), eq(nodes.status, fromStatus)))
        .returning({ id: nodes.id });

      if (result.length === 0) {
        throw new ConcurrentTransitionError(id);
      }

      await tx.insert(nodeTransitions).values({
        id: randomUUID(),
        nodeId: id,
        fromStatus,
        toStatus: to,
        reason,
        triggeredBy,
        createdAt: now,
      });

      return { ...node, status: to, updatedAt: now, ...extraFields };
    });
  }

  async register(data: NodeRegistration): Promise<Node> {
    const now = Math.floor(Date.now() / 1000);
    const existingRows = await this.db.select().from(nodes).where(eq(nodes.id, data.nodeId));
    const existing = existingRows[0] ? toNode(existingRows[0]) : null;

    if (!existing) {
      await this.db.insert(nodes).values({
        id: data.nodeId,
        host: data.host,
        capacityMb: data.capacityMb,
        usedMb: 0,
        agentVersion: data.agentVersion,
        status: "provisioning",
        lastHeartbeatAt: now,
        registeredAt: now,
        updatedAt: now,
      });
      return this.transition(data.nodeId, "active", "first_registration", "node_agent");
    }

    const deadStates: NodeStatus[] = ["offline", "recovering", "failed"];
    if (deadStates.includes(existing.status as NodeStatus)) {
      await this.db
        .update(nodes)
        .set({
          host: data.host,
          agentVersion: data.agentVersion,
          updatedAt: now,
        })
        .where(eq(nodes.id, data.nodeId));
      return this.transition(data.nodeId, "returning", "re_registration", "node_agent");
    }

    // Healthy node re-registering — metadata update only, no transition
    const rows = await this.db
      .update(nodes)
      .set({
        host: data.host,
        agentVersion: data.agentVersion,
        updatedAt: now,
      })
      .where(eq(nodes.id, data.nodeId))
      .returning();
    return toNode(rows[0]);
  }

  async registerSelfHosted(data: SelfHostedNodeRegistration): Promise<Node> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.insert(nodes).values({
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
    });
    return this.transition(data.nodeId, "active", "first_registration", "node_agent");
  }

  async updateHeartbeat(id: string, usedMb: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .update(nodes)
      .set({ lastHeartbeatAt: now, usedMb, updatedAt: now })
      .where(eq(nodes.id, id))
      .returning({ id: nodes.id });
    if (result.length === 0) throw new NodeNotFoundError(id);
  }

  async addCapacity(id: string, deltaMb: number): Promise<void> {
    const result = await this.db
      .update(nodes)
      .set({ usedMb: sql`GREATEST(0, ${nodes.usedMb} + ${deltaMb})` })
      .where(eq(nodes.id, id))
      .returning({ id: nodes.id });
    if (result.length === 0) throw new NodeNotFoundError(id);
  }

  async findBestTarget(excludeId: string, requiredMb: number): Promise<Node | null> {
    const rows = await this.db
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
      .limit(1);
    return rows[0] ? toNode(rows[0]) : null;
  }

  async listTransitions(nodeId: string, limit = 50): Promise<NodeTransition[]> {
    const rows = await this.db
      .select()
      .from(nodeTransitions)
      .where(eq(nodeTransitions.nodeId, nodeId))
      .orderBy(desc(nodeTransitions.createdAt))
      .limit(limit);
    return rows.map(toNodeTransition);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(nodes).where(eq(nodes.id, id));
  }
}
