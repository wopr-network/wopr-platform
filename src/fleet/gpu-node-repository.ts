import { eq, inArray } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { gpuNodes } from "../db/schema/index.js";
import type { GpuNode, GpuNodeStatus, NewGpuNode } from "./repository-types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IGpuNodeRepository {
  insert(node: NewGpuNode): GpuNode;
  getById(id: string): GpuNode | null;
  list(statuses?: GpuNodeStatus[]): GpuNode[];
  updateStage(id: string, provisionStage: string): void;
  updateStatus(id: string, status: GpuNodeStatus): void;
  updateHost(id: string, host: string, dropletId: string, monthlyCostCents: number): void;
  updateServiceHealth(id: string, serviceHealth: Record<string, "ok" | "down">, lastHealthAt: number): void;
  setError(id: string, lastError: string): void;
  delete(id: string): void;
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

  insert(node: NewGpuNode): GpuNode {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .insert(gpuNodes)
      .values({
        id: node.id,
        region: node.region,
        size: node.size,
        status: "provisioning",
        provisionStage: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const created = this.getById(node.id);
    if (!created) throw new Error(`GPU node not found after insert: ${node.id}`);
    return created;
  }

  getById(id: string): GpuNode | null {
    const row = this.db.select().from(gpuNodes).where(eq(gpuNodes.id, id)).get();
    return row ? toGpuNode(row) : null;
  }

  list(statuses?: GpuNodeStatus[]): GpuNode[] {
    if (statuses && statuses.length > 0) {
      return this.db.select().from(gpuNodes).where(inArray(gpuNodes.status, statuses)).all().map(toGpuNode);
    }
    return this.db.select().from(gpuNodes).all().map(toGpuNode);
  }

  updateStage(id: string, provisionStage: string): void {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.update(gpuNodes).set({ provisionStage, updatedAt: now }).where(eq(gpuNodes.id, id)).run();
    if (result.changes === 0) throw new Error(`GPU node not found: ${id}`);
  }

  updateStatus(id: string, status: GpuNodeStatus): void {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.update(gpuNodes).set({ status, updatedAt: now }).where(eq(gpuNodes.id, id)).run();
    if (result.changes === 0) throw new Error(`GPU node not found: ${id}`);
  }

  updateHost(id: string, host: string, dropletId: string, monthlyCostCents: number): void {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .update(gpuNodes)
      .set({ host, dropletId, monthlyCostCents, updatedAt: now })
      .where(eq(gpuNodes.id, id))
      .run();
    if (result.changes === 0) throw new Error(`GPU node not found: ${id}`);
  }

  updateServiceHealth(id: string, serviceHealth: Record<string, "ok" | "down">, lastHealthAt: number): void {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .update(gpuNodes)
      .set({
        serviceHealth: JSON.stringify(serviceHealth),
        lastHealthAt,
        updatedAt: now,
      })
      .where(eq(gpuNodes.id, id))
      .run();
    if (result.changes === 0) throw new Error(`GPU node not found: ${id}`);
  }

  setError(id: string, lastError: string): void {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.update(gpuNodes).set({ lastError, updatedAt: now }).where(eq(gpuNodes.id, id)).run();
    if (result.changes === 0) throw new Error(`GPU node not found: ${id}`);
  }

  delete(id: string): void {
    const result = this.db.delete(gpuNodes).where(eq(gpuNodes.id, id)).run();
    if (result.changes === 0) throw new Error(`GPU node not found: ${id}`);
  }
}
