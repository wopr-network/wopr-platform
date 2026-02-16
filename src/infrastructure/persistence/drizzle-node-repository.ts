/**
 * Drizzle Implementation: NodeRepository (ASYNC API)
 */
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { nodes } from "../../db/schema/nodes.js";
import { Node, type NodeStatus } from "../../domain/entities/node.js";
import type { NodeRepository } from "../../domain/repositories/node-repository.js";

function rowToNode(row: typeof nodes.$inferSelect): Node {
  return Node.fromRow({
    id: row.id,
    host: row.host,
    status: row.status as NodeStatus,
    capacityMb: row.capacityMb,
    usedMb: row.usedMb,
    agentVersion: row.agentVersion,
    lastHeartbeatAt: row.lastHeartbeatAt,
    registeredAt: row.registeredAt,
    updatedAt: row.updatedAt,
  });
}

export class DrizzleNodeRepository implements NodeRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(nodeId: string): Promise<Node | null> {
    const row = this.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();

    return row ? rowToNode(row) : null;
  }

  async register(registration: {
    nodeId: string;
    host: string;
    capacityMb: number;
    agentVersion: string;
  }): Promise<Node> {
    const now = Math.floor(Date.now() / 1000);

    const existing = await this.get(registration.nodeId);

    if (existing) {
      await this.db
        .update(nodes)
        .set({
          host: registration.host,
          capacityMb: registration.capacityMb,
          agentVersion: registration.agentVersion,
          status: "active",
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        .where(eq(nodes.id, registration.nodeId))
        .run();

      const node = await this.get(registration.nodeId);
      if (!node) {
        throw new Error("Failed to upsert node");
      }
      return node;
    }

    await this.db
      .insert(nodes)
      .values({
        id: registration.nodeId,
        host: registration.host,
        capacityMb: registration.capacityMb,
        usedMb: 0,
        agentVersion: registration.agentVersion,
        status: "active",
        lastHeartbeatAt: now,
        registeredAt: now,
        updatedAt: now,
      })
      .run();

    const node = await this.get(registration.nodeId);
    if (!node) {
      throw new Error("Failed to create node");
    }
    return node;
  }

  async list(): Promise<Node[]> {
    const rows = this.db.select().from(nodes).all();
    return rows.map(rowToNode);
  }

  async listByStatus(status: NodeStatus): Promise<Node[]> {
    const rows = this.db.select().from(nodes).where(eq(nodes.status, status)).all();
    return rows.map(rowToNode);
  }

  async listActive(): Promise<Node[]> {
    return this.listByStatus("active");
  }

  async updateHeartbeat(nodeId: string, agentVersion: string, usedMb: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    await this.db
      .update(nodes)
      .set({
        lastHeartbeatAt: now,
        usedMb,
        agentVersion,
        status: "active",
        updatedAt: now,
      })
      .where(eq(nodes.id, nodeId))
      .run();
  }

  async updateCapacity(nodeId: string, usedMb: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    await this.db
      .update(nodes)
      .set({
        usedMb,
        updatedAt: now,
      })
      .where(eq(nodes.id, nodeId))
      .run();
  }

  async updateStatus(nodeId: string, status: NodeStatus): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    await this.db
      .update(nodes)
      .set({
        status,
        updatedAt: now,
      })
      .where(eq(nodes.id, nodeId))
      .run();
  }

  async findBestForRecovery(excludeNodeId: string, requiredMb: number): Promise<Node | null> {
    const row = this.db
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.status, "active"),
          ne(nodes.id, excludeNodeId),
          sql`(${nodes.capacityMb} - ${nodes.usedMb}) >= ${requiredMb}`,
        ),
      )
      .orderBy(desc(sql`${nodes.capacityMb} - ${nodes.usedMb}`))
      .limit(1)
      .get();

    return row ? rowToNode(row) : null;
  }

  async delete(nodeId: string): Promise<void> {
    await this.db.delete(nodes).where(eq(nodes.id, nodeId)).run();
  }
}
