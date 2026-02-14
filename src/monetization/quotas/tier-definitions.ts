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
  maxSpendPerHour: z.number().min(0).nullable().default(null), // null = unlimited, USD
  maxSpendPerMonth: z.number().min(0).nullable().default(null), // null = unlimited, USD
});

export type PlanTier = z.infer<typeof planTierSchema>;

/** Ordered tier hierarchy — higher index = higher tier */
export const TIER_HIERARCHY = ["free", "pro", "team", "enterprise"] as const;
export type TierName = (typeof TIER_HIERARCHY)[number];

/** Returns true when `current` tier is >= `required` tier in the hierarchy */
export function tierSatisfies(current: string, required: string): boolean {
  const currentIdx = TIER_HIERARCHY.indexOf(current as TierName);
  const requiredIdx = TIER_HIERARCHY.indexOf(required as TierName);
  if (currentIdx === -1 || requiredIdx === -1) return false;
  return currentIdx >= requiredIdx;
}

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
    maxSpendPerHour: 0.5, // $0.50/hour hard cap
    maxSpendPerMonth: 5, // $5/month hard cap
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
    features: ["premium_plugins", "priority-support", "custom-domains"],
    maxSpendPerHour: 10, // $10/hour
    maxSpendPerMonth: 200, // $200/month
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
    features: ["premium_plugins", "priority-support", "custom-domains", "team-management", "audit-logs"],
    maxSpendPerHour: 50, // $50/hour
    maxSpendPerMonth: 1000, // $1000/month
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
    features: [
      "premium_plugins",
      "priority-support",
      "custom-domains",
      "team-management",
      "audit-logs",
      "sso",
      "dedicated-support",
    ],
    maxSpendPerHour: null, // unlimited (custom agreements)
    maxSpendPerMonth: null, // unlimited (custom agreements)
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
    features TEXT NOT NULL DEFAULT '[]',
    max_spend_per_hour REAL DEFAULT NULL,
    max_spend_per_month REAL DEFAULT NULL
  )
`;

const CREATE_SPEND_OVERRIDES_SQL = `
  CREATE TABLE IF NOT EXISTS tenant_spend_overrides (
    tenant TEXT PRIMARY KEY,
    max_spend_per_hour REAL DEFAULT NULL,
    max_spend_per_month REAL DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
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
    this.db.exec(CREATE_SPEND_OVERRIDES_SQL);
    this.migrate();
  }

  /** Add spend-limit columns to pre-existing plan_tiers tables. */
  private migrate(): void {
    const cols = this.db.prepare("PRAGMA table_info(plan_tiers)").all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("max_spend_per_hour")) {
      this.db.exec("ALTER TABLE plan_tiers ADD COLUMN max_spend_per_hour REAL DEFAULT NULL");
    }
    if (!names.has("max_spend_per_month")) {
      this.db.exec("ALTER TABLE plan_tiers ADD COLUMN max_spend_per_month REAL DEFAULT NULL");
    }
  }

  /** Seed default tiers (skips existing rows) */
  seed(tiers: PlanTier[] = DEFAULT_TIERS): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO plan_tiers
        (id, name, max_instances, max_plugins_per_instance, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features, max_spend_per_hour, max_spend_per_month)
      VALUES
        (@id, @name, @maxInstances, @maxPluginsPerInstance, @memoryLimitMb, @cpuQuota, @storageLimitMb, @maxProcesses, @features, @maxSpendPerHour, @maxSpendPerMonth)
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
          maxSpendPerHour: tier.maxSpendPerHour,
          maxSpendPerMonth: tier.maxSpendPerMonth,
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
        (id, name, max_instances, max_plugins_per_instance, memory_limit_mb, cpu_quota, storage_limit_mb, max_processes, features, max_spend_per_hour, max_spend_per_month)
      VALUES
        (@id, @name, @maxInstances, @maxPluginsPerInstance, @memoryLimitMb, @cpuQuota, @storageLimitMb, @maxProcesses, @features, @maxSpendPerHour, @maxSpendPerMonth)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        max_instances = excluded.max_instances,
        max_plugins_per_instance = excluded.max_plugins_per_instance,
        memory_limit_mb = excluded.memory_limit_mb,
        cpu_quota = excluded.cpu_quota,
        storage_limit_mb = excluded.storage_limit_mb,
        max_processes = excluded.max_processes,
        features = excluded.features,
        max_spend_per_hour = excluded.max_spend_per_hour,
        max_spend_per_month = excluded.max_spend_per_month
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
        maxSpendPerHour: tier.maxSpendPerHour,
        maxSpendPerMonth: tier.maxSpendPerMonth,
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
      maxSpendPerHour: row.max_spend_per_hour ?? null,
      maxSpendPerMonth: row.max_spend_per_month ?? null,
    });
  }
}

/** Per-tenant spend limit overrides stored in SQLite */
export interface SpendOverride {
  tenant: string;
  maxSpendPerHour: number | null;
  maxSpendPerMonth: number | null;
  notes: string | null;
  updatedAt: number;
}

/** Manages per-tenant spend limit overrides */
export class SpendOverrideStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(CREATE_SPEND_OVERRIDES_SQL);
  }

  /** Get override for a tenant, or null if none */
  get(tenant: string): SpendOverride | null {
    const row = this.db.prepare("SELECT * FROM tenant_spend_overrides WHERE tenant = ?").get(tenant) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      tenant: row.tenant as string,
      maxSpendPerHour: (row.max_spend_per_hour as number | null) ?? null,
      maxSpendPerMonth: (row.max_spend_per_month as number | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      updatedAt: row.updated_at as number,
    };
  }

  /** Set (upsert) a spend override for a tenant */
  set(
    tenant: string,
    override: { maxSpendPerHour?: number | null; maxSpendPerMonth?: number | null; notes?: string | null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO tenant_spend_overrides (tenant, max_spend_per_hour, max_spend_per_month, notes, updated_at)
         VALUES (@tenant, @maxSpendPerHour, @maxSpendPerMonth, @notes, @updatedAt)
         ON CONFLICT(tenant) DO UPDATE SET
           max_spend_per_hour = COALESCE(@maxSpendPerHour, tenant_spend_overrides.max_spend_per_hour),
           max_spend_per_month = COALESCE(@maxSpendPerMonth, tenant_spend_overrides.max_spend_per_month),
           notes = COALESCE(@notes, tenant_spend_overrides.notes),
           updated_at = @updatedAt`,
      )
      .run({
        tenant,
        maxSpendPerHour: override.maxSpendPerHour ?? null,
        maxSpendPerMonth: override.maxSpendPerMonth ?? null,
        notes: override.notes ?? null,
        updatedAt: Date.now(),
      });
  }

  /** Remove a tenant's override */
  delete(tenant: string): boolean {
    const result = this.db.prepare("DELETE FROM tenant_spend_overrides WHERE tenant = ?").run(tenant);
    return result.changes > 0;
  }

  /** List all overrides */
  list(): SpendOverride[] {
    const rows = this.db.prepare("SELECT * FROM tenant_spend_overrides ORDER BY tenant").all() as Record<
      string,
      unknown
    >[];
    return rows.map((row) => ({
      tenant: row.tenant as string,
      maxSpendPerHour: (row.max_spend_per_hour as number | null) ?? null,
      maxSpendPerMonth: (row.max_spend_per_month as number | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      updatedAt: row.updated_at as number,
    }));
  }
}
