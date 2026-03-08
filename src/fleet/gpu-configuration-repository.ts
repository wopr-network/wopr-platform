import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { gpuConfigurations } from "../db/schema/index.js";

export interface GpuConfiguration {
  gpuNodeId: string;
  memoryLimitMib: number | null;
  modelAssignments: string[];
  maxConcurrency: number;
  notes: string | null;
  updatedAt: number;
}

export interface IGpuConfigurationRepository {
  list(): Promise<GpuConfiguration[]>;
  getByNodeId(gpuNodeId: string): Promise<GpuConfiguration | null>;
  upsert(config: Omit<GpuConfiguration, "updatedAt">): Promise<GpuConfiguration>;
}

function toConfiguration(row: typeof gpuConfigurations.$inferSelect): GpuConfiguration {
  return {
    gpuNodeId: row.gpuNodeId,
    memoryLimitMib: row.memoryLimitMib ?? null,
    modelAssignments: (() => {
      if (!row.modelAssignments) return [];
      try {
        return JSON.parse(row.modelAssignments) as string[];
      } catch {
        return [];
      }
    })(),
    maxConcurrency: row.maxConcurrency,
    notes: row.notes ?? null,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleGpuConfigurationRepository implements IGpuConfigurationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async list(): Promise<GpuConfiguration[]> {
    const rows = await this.db.select().from(gpuConfigurations);
    return rows.map(toConfiguration);
  }

  async getByNodeId(gpuNodeId: string): Promise<GpuConfiguration | null> {
    const rows = await this.db.select().from(gpuConfigurations).where(eq(gpuConfigurations.gpuNodeId, gpuNodeId));
    return rows[0] ? toConfiguration(rows[0]) : null;
  }

  async upsert(config: Omit<GpuConfiguration, "updatedAt">): Promise<GpuConfiguration> {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.db
      .insert(gpuConfigurations)
      .values({
        gpuNodeId: config.gpuNodeId,
        memoryLimitMib: config.memoryLimitMib,
        modelAssignments: JSON.stringify(config.modelAssignments),
        maxConcurrency: config.maxConcurrency,
        notes: config.notes,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: gpuConfigurations.gpuNodeId,
        set: {
          memoryLimitMib: config.memoryLimitMib,
          modelAssignments: JSON.stringify(config.modelAssignments),
          maxConcurrency: config.maxConcurrency,
          notes: config.notes,
          updatedAt: now,
        },
      })
      .returning();
    if (!rows[0]) throw new Error("GPU configuration upsert returned no rows");
    return toConfiguration(rows[0]);
  }
}
