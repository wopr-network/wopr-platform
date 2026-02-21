import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { nodeTransitions } from "../db/schema/node-transitions.js";
import { nodes } from "../db/schema/nodes.js";
import {
  ConcurrentTransitionError,
  InvalidTransitionError,
  isValidTransition,
  NodeNotFoundError,
  type NodeStatus,
} from "./node-state-machine.js";

export type Node = typeof nodes.$inferSelect;
export type NodeTransition = typeof nodeTransitions.$inferSelect;

export interface NodeRegistration {
  nodeId: string;
  host: string;
  capacityMb: number;
  agentVersion: string;
}

export interface INodeRepository {
  getById(id: string): Node | null;
  list(statuses?: NodeStatus[]): Node[];
  register(data: NodeRegistration): Node;
  transition(id: string, to: NodeStatus, reason: string, triggeredBy: string): Node;
  updateHeartbeat(id: string, usedMb: number): void;
  addCapacity(id: string, deltaMb: number): void;
  findBestTarget(excludeId: string, requiredMb: number): Node | null;
  listTransitions(nodeId: string, limit?: number): NodeTransition[];
}

export class DrizzleNodeRepository implements INodeRepository {
  constructor(private readonly db: DrizzleDb) {}

  getById(id: string): Node | null {
    return this.db.select().from(nodes).where(eq(nodes.id, id)).get() ?? null;
  }

  list(statuses?: NodeStatus[]): Node[] {
    if (statuses && statuses.length > 0) {
      return this.db.select().from(nodes).where(inArray(nodes.status, statuses)).all();
    }
    return this.db.select().from(nodes).all();
  }

  transition(id: string, to: NodeStatus, reason: string, triggeredBy: string): Node {
    const now = Math.floor(Date.now() / 1000);

    return this.db.transaction(() => {
      const node = this.getById(id);
      if (!node) throw new NodeNotFoundError(id);

      if (!isValidTransition(node.status as NodeStatus, to)) {
        throw new InvalidTransitionError(node.status as NodeStatus, to);
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
    const existing = this.getById(data.nodeId);

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
    return this.db
      .update(nodes)
      .set({
        host: data.host,
        agentVersion: data.agentVersion,
        updatedAt: now,
      })
      .where(eq(nodes.id, data.nodeId))
      .returning()
      .get();
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
    return (
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
        .get() ?? null
    );
  }

  listTransitions(nodeId: string, limit = 50): NodeTransition[] {
    return this.db
      .select()
      .from(nodeTransitions)
      .where(eq(nodeTransitions.nodeId, nodeId))
      .orderBy(desc(nodeTransitions.createdAt))
      .limit(limit)
      .all();
  }
}
