import { eq, inArray } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { gpuNodes } from "../db/schema/index.js";
import type { GpuNode, GpuNodeStatus, NewGpuNode } from "./repository-types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IGpuNodeRepository {
  insert(node: NewGpuNode): Promise<GpuNode>;
  getById(id: string): Promise<GpuNode | null>;
  list(statuses?: GpuNodeStatus[]): Promise<GpuNode[]>;
  updateStage(id: string, provisionStage: string): Promise<void>;
  updateStatus(id: string, status: GpuNodeStatus): Promise<void>;
  updateHost(id: string, host: string, dropletId: string, monthlyCostCents: number): Promise<void>;
  updateServiceHealth(id: string, serviceHealth: Record<string, "ok" | "down">, lastHealthAt: number): Promise<void>;
  setError(id: string, lastError: string): Promise<void>;
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Row → Domain mapper
// ---------------------------------------------------------------------------

function toGpuNode(row: typeof gpuNodes.$inferSelect): GpuNode {
  return {
    id: row.id,
    dropletId: row.dropletId ?? null,
    host: row.host ?? null,
    region: row.region,
    size: row.size,
    status: row.status as GpuNodeStatus,
    provisionStage: row.provisionStage,
    serviceHealth: row.serviceHealth ? (JSON.parse(row.serviceHealth) as Record<string, "ok" | "down">) : null,
    monthlyCostCents: row.monthlyCostCents ?? null,
    lastHealthAt: row.lastHealthAt ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DrizzleGpuNodeRepository implements IGpuNodeRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(node: NewGpuNode): Promise<GpuNode> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.insert(gpuNodes).values({
      id: node.id,
      region: node.region,
      size: node.size,
      status: "provisioning",
      provisionStage: "pending",
      createdAt: now,
      updatedAt: now,
    });
    const created = await this.getById(node.id);
    if (!created) throw new Error(`GPU node not found after insert: ${node.id}`);
    return created;
  }

  async getById(id: string): Promise<GpuNode | null> {
    const rows = await this.db.select().from(gpuNodes).where(eq(gpuNodes.id, id));
    return rows[0] ? toGpuNode(rows[0]) : null;
  }

  async list(statuses?: GpuNodeStatus[]): Promise<GpuNode[]> {
    if (statuses && statuses.length > 0) {
      const rows = await this.db.select().from(gpuNodes).where(inArray(gpuNodes.status, statuses));
      return rows.map(toGpuNode);
    }
    const rows = await this.db.select().from(gpuNodes);
    return rows.map(toGpuNode);
  }

  async updateStage(id: string, provisionStage: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .update(gpuNodes)
      .set({ provisionStage, updatedAt: now })
      .where(eq(gpuNodes.id, id))
      .returning({ id: gpuNodes.id });
    if (result.length === 0) throw new Error(`GPU node not found: ${id}`);
  }

  async updateStatus(id: string, status: GpuNodeStatus): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .update(gpuNodes)
      .set({ status, updatedAt: now })
      .where(eq(gpuNodes.id, id))
      .returning({ id: gpuNodes.id });
    if (result.length === 0) throw new Error(`GPU node not found: ${id}`);
  }

  async updateHost(id: string, host: string, dropletId: string, monthlyCostCents: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .update(gpuNodes)
      .set({ host, dropletId, monthlyCostCents, updatedAt: now })
      .where(eq(gpuNodes.id, id))
      .returning({ id: gpuNodes.id });
    if (result.length === 0) throw new Error(`GPU node not found: ${id}`);
  }

  async updateServiceHealth(
    id: string,
    serviceHealth: Record<string, "ok" | "down">,
    lastHealthAt: number,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .update(gpuNodes)
      .set({
        serviceHealth: JSON.stringify(serviceHealth),
        lastHealthAt,
        updatedAt: now,
      })
      .where(eq(gpuNodes.id, id))
      .returning({ id: gpuNodes.id });
    if (result.length === 0) throw new Error(`GPU node not found: ${id}`);
  }

  async setError(id: string, lastError: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .update(gpuNodes)
      .set({ lastError, updatedAt: now })
      .where(eq(gpuNodes.id, id))
      .returning({ id: gpuNodes.id });
    if (result.length === 0) throw new Error(`GPU node not found: ${id}`);
  }

  async delete(id: string): Promise<void> {
    const result = await this.db.delete(gpuNodes).where(eq(gpuNodes.id, id)).returning({ id: gpuNodes.id });
    if (result.length === 0) throw new Error(`GPU node not found: ${id}`);
  }
}
