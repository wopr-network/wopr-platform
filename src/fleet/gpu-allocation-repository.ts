import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { gpuAllocations } from "../db/schema/index.js";

export type AllocationPriority = "low" | "normal" | "high";

export interface GpuAllocation {
  id: string;
  gpuNodeId: string;
  tenantId: string;
  botInstanceId: string | null;
  priority: AllocationPriority;
  createdAt: number;
  updatedAt: number;
}

export interface IGpuAllocationRepository {
  list(): Promise<GpuAllocation[]>;
  listByGpuNodeId(gpuNodeId: string): Promise<GpuAllocation[]>;
  listByTenantId(tenantId: string): Promise<GpuAllocation[]>;
  upsert(alloc: Omit<GpuAllocation, "createdAt" | "updatedAt">): Promise<GpuAllocation>;
  delete(id: string): Promise<void>;
}

function toAllocation(row: typeof gpuAllocations.$inferSelect): GpuAllocation {
  return {
    id: row.id,
    gpuNodeId: row.gpuNodeId,
    tenantId: row.tenantId,
    botInstanceId: row.botInstanceId ?? null,
    priority: (row.priority as AllocationPriority) ?? "normal",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleGpuAllocationRepository implements IGpuAllocationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async list(): Promise<GpuAllocation[]> {
    const rows = await this.db.select().from(gpuAllocations);
    return rows.map(toAllocation);
  }

  async listByGpuNodeId(gpuNodeId: string): Promise<GpuAllocation[]> {
    const rows = await this.db.select().from(gpuAllocations).where(eq(gpuAllocations.gpuNodeId, gpuNodeId));
    return rows.map(toAllocation);
  }

  async listByTenantId(tenantId: string): Promise<GpuAllocation[]> {
    const rows = await this.db.select().from(gpuAllocations).where(eq(gpuAllocations.tenantId, tenantId));
    return rows.map(toAllocation);
  }

  async upsert(alloc: Omit<GpuAllocation, "createdAt" | "updatedAt">): Promise<GpuAllocation> {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.db
      .insert(gpuAllocations)
      .values({
        id: alloc.id,
        gpuNodeId: alloc.gpuNodeId,
        tenantId: alloc.tenantId,
        botInstanceId: alloc.botInstanceId,
        priority: alloc.priority,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: gpuAllocations.id,
        set: {
          gpuNodeId: alloc.gpuNodeId,
          tenantId: alloc.tenantId,
          botInstanceId: alloc.botInstanceId,
          priority: alloc.priority,
          updatedAt: now,
        },
      })
      .returning();
    return toAllocation(rows[0]);
  }

  async delete(id: string): Promise<void> {
    const result = await this.db
      .delete(gpuAllocations)
      .where(eq(gpuAllocations.id, id))
      .returning({ id: gpuAllocations.id });
    if (result.length === 0) throw new Error(`GPU allocation not found: ${id}`);
  }
}
