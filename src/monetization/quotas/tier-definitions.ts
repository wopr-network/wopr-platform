import type Database from "better-sqlite3";
import { z } from "zod";

/** Schema for a plan tier stored in the database */
export const planTierSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  maxInstances: z.number().int().min(0), // 0 = unlimited
  maxPluginsPerInstance: z.number().int().min(0).nullable(), // null = unlimited
  memoryLimitMb: z.number().int().min(64),
  cpuQuota: z.number().int().min(1000),
  storageLimitMb: z.number().int().min(64),
  maxProcesses: z.number().int().min(10).default(256),
  features: z.array(z.string()).default([]),
});

export type PlanTier = z.infer<typeof planTierSchema>;

/** Default tier definitions seeded on first run */
export const DEFAULT_TIERS: PlanTier[] = [
  {
    id: "free",
    name: "free",
    maxInstances: 1,
    maxPluginsPerInstance: 5,
    memoryLimitMb: 512,
    cpuQuota: 50_000, // 0.5 CPU
    storageLimitMb: 1024,
    maxProcesses: 128,
    features: [],
  },
  {
    id: "pro",
    name: "pro",
    maxInstances: 5,
    maxPluginsPerInstance: null, // unlimited
    memoryLimitMb: 2048,
    cpuQuota: 200_000, // 2 CPUs
    storageLimitMb: 10_240,
    maxProcesses: 512,
    features: ["priority-support", "custom-domains"],
  },
  {
    id: "team",
    name: "team",
    maxInstances: 20,
    maxPluginsPerInstance: null,
    memoryLimitMb: 4096,
    cpuQuota: 400_000, // 4 CPUs
    storageLimitMb: 51_200,
    maxProcesses: 1024,
    features: ["priority-support", "custom-domains", "team-management", "audit-logs"],
  },
  {
    id: "enterprise",
    name: "enterprise",
    maxInstances: 0, // unlimited
    maxPluginsPerInstance: null,
    memoryLimitMb: 16_384,
    cpuQuota: 800_000, // 8 CPUs
    storageLimitMb: 102_400,
    maxProcesses: 4096,
    features: ["priority-support", "custom-domains", "team-management", "audit-logs", "sso", "dedicated-support"],
  },
];

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS plan_tiers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    max_instances INTEGER NOT NULL DEFAULT 1,
    max_plugins_per_instance INTEGER DEFAULT NULL,
    memory_limit_mb INTEGER NOT NULL DEFAULT 512,
    cpu_quota INTEGER NOT NULL DEFAULT 50000,
    storage_limit_mb INTEGER NOT NULL DEFAULT 1024,
    max_processes INTEGER NOT NULL DEFAULT 256,
    features TEXT NOT NULL DEFAULT '[]'
  )
`;

/** Manages plan tier definitions in SQLite */
export class TierStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
    this.db.exec(CREATE_TABLE_SQL);
  }

  /** Seed default tiers (skips existing rows) */
  seed(tiers: PlanTier[] = DEFAULT_TIERS): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO plan_tiers
        (id, name, max_instances, max_plugins_per_instance, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features)
      VALUES
        (@id, @name, @maxInstances, @maxPluginsPerInstance, @memoryLimitMb, @cpuQuota, @storageLimitMb, @maxProcesses, @features)
    `);

    const seedAll = this.db.transaction((rows: PlanTier[]) => {
      for (const tier of rows) {
        insert.run({
          id: tier.id,
          name: tier.name,
          maxInstances: tier.maxInstances,
          maxPluginsPerInstance: tier.maxPluginsPerInstance,
          memoryLimitMb: tier.memoryLimitMb,
          cpuQuota: tier.cpuQuota,
          storageLimitMb: tier.storageLimitMb,
          maxProcesses: tier.maxProcesses,
          features: JSON.stringify(tier.features),
        });
      }
    });

    seedAll(tiers);
  }

  /** Get a tier by ID */
  get(id: string): PlanTier | null {
    const row = this.db.prepare("SELECT * FROM plan_tiers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTier(row);
  }

  /** List all tiers */
  list(): PlanTier[] {
    const rows = this.db.prepare("SELECT * FROM plan_tiers ORDER BY max_instances ASC").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToTier(r));
  }

  /** Upsert a tier */
  upsert(tier: PlanTier): void {
    this.db
      .prepare(
        `
      INSERT INTO plan_tiers
        (id, name, max_instances, max_plugins_per_instance, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features)
      VALUES
        (@id, @name, @maxInstances, @maxPluginsPerInstance, @memoryLimitMb, @cpuQuota, @storageLimitMb, @maxProcesses, @features)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        max_instances = excluded.max_instances,
        max_plugins_per_instance = excluded.max_plugins_per_instance,
        memory_limit_mb = excluded.memory_limit_mb,
        cpu_quota = excluded.cpu_quota,
        storage_limit_mb = excluded.storage_limit_mb,
        max_processes = excluded.max_processes,
        features = excluded.features
    `,
      )
      .run({
        id: tier.id,
        name: tier.name,
        maxInstances: tier.maxInstances,
        maxPluginsPerInstance: tier.maxPluginsPerInstance,
        memoryLimitMb: tier.memoryLimitMb,
        cpuQuota: tier.cpuQuota,
        storageLimitMb: tier.storageLimitMb,
        maxProcesses: tier.maxProcesses,
        features: JSON.stringify(tier.features),
      });
  }

  /** Delete a tier by ID */
  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM plan_tiers WHERE id = ?").run(id);
    return result.changes > 0;
  }

  private rowToTier(row: Record<string, unknown>): PlanTier {
    return planTierSchema.parse({
      id: row.id,
      name: row.name,
      maxInstances: row.max_instances,
      maxPluginsPerInstance: row.max_plugins_per_instance,
      memoryLimitMb: row.memory_limit_mb,
      cpuQuota: row.cpu_quota,
      storageLimitMb: row.storage_limit_mb,
      maxProcesses: row.max_processes,
      features: JSON.parse(row.features as string),
    });
  }
}
