import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { adapterRateOverrides } from "../../db/schema/adapter-rate-overrides.js";

export type RateOverrideStatus = "scheduled" | "active" | "expired" | "cancelled";

export interface AdapterRateOverride {
  id: string;
  adapterId: string;
  name: string;
  discountPercent: number;
  startsAt: Date;
  endsAt: Date | null;
  status: RateOverrideStatus;
  createdBy: string;
  createdAt: Date;
  notes: string | null;
}

export interface IAdapterRateOverrideRepository {
  create(input: Omit<AdapterRateOverride, "id" | "createdAt">): Promise<AdapterRateOverride>;
  getById(id: string): Promise<AdapterRateOverride | null>;
  list(filters?: { status?: RateOverrideStatus; adapterId?: string }): Promise<AdapterRateOverride[]>;
  findActiveForAdapter(adapterId: string, now?: Date): Promise<AdapterRateOverride | null>;
  updateStatus(id: string, status: RateOverrideStatus): Promise<void>;
}

export class DrizzleAdapterRateOverrideRepository implements IAdapterRateOverrideRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: Omit<AdapterRateOverride, "id" | "createdAt">): Promise<AdapterRateOverride> {
    const rows = await this.db
      .insert(adapterRateOverrides)
      .values({
        adapterId: input.adapterId,
        name: input.name,
        discountPercent: input.discountPercent,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        status: input.status,
        createdBy: input.createdBy,
        notes: input.notes ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to insert adapter rate override");
    return this.#map(row);
  }

  async getById(id: string): Promise<AdapterRateOverride | null> {
    const row = (await this.db.select().from(adapterRateOverrides).where(eq(adapterRateOverrides.id, id)).limit(1))[0];
    return row ? this.#map(row) : null;
  }

  async list(filters?: { status?: RateOverrideStatus; adapterId?: string }): Promise<AdapterRateOverride[]> {
    const conditions = [];
    if (filters?.status) conditions.push(eq(adapterRateOverrides.status, filters.status));
    if (filters?.adapterId) conditions.push(eq(adapterRateOverrides.adapterId, filters.adapterId));
    const rows =
      conditions.length > 0
        ? await this.db
            .select()
            .from(adapterRateOverrides)
            .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        : await this.db.select().from(adapterRateOverrides);
    return rows.map((r) => this.#map(r));
  }

  async findActiveForAdapter(adapterId: string, now?: Date): Promise<AdapterRateOverride | null> {
    const ts = now ?? new Date();
    const row = (
      await this.db
        .select()
        .from(adapterRateOverrides)
        .where(
          and(
            eq(adapterRateOverrides.adapterId, adapterId),
            eq(adapterRateOverrides.status, "active"),
            lte(adapterRateOverrides.startsAt, ts),
            or(isNull(adapterRateOverrides.endsAt), sql`${adapterRateOverrides.endsAt} >= ${ts}`),
          ),
        )
        .limit(1)
    )[0];
    return row ? this.#map(row) : null;
  }

  async updateStatus(id: string, status: RateOverrideStatus): Promise<void> {
    await this.db.update(adapterRateOverrides).set({ status }).where(eq(adapterRateOverrides.id, id));
  }

  #map(row: typeof adapterRateOverrides.$inferSelect): AdapterRateOverride {
    return {
      id: row.id,
      adapterId: row.adapterId,
      name: row.name,
      discountPercent: row.discountPercent,
      startsAt: row.startsAt,
      endsAt: row.endsAt ?? null,
      status: row.status as RateOverrideStatus,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      notes: row.notes ?? null,
    };
  }
}

export class AdapterRateOverrideCache {
  private cache = new Map<string, { override: AdapterRateOverride | null; expiresAt: number }>();
  private readonly ttlMs = 60_000;

  constructor(private readonly repo: IAdapterRateOverrideRepository) {}

  async getDiscountPercent(adapterId: string): Promise<number> {
    const now = Date.now();
    const cached = this.cache.get(adapterId);
    if (cached && cached.expiresAt > now) {
      return cached.override?.discountPercent ?? 0;
    }
    const override = await this.repo.findActiveForAdapter(adapterId);
    this.cache.set(adapterId, { override, expiresAt: now + this.ttlMs });
    return override?.discountPercent ?? 0;
  }

  invalidate(adapterId: string): void {
    this.cache.delete(adapterId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}
