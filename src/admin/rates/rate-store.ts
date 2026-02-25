import crypto from "node:crypto";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { providerCosts, sellRates } from "../../db/schema/index.js";

export interface SellRate {
  id: string;
  capability: string;
  display_name: string;
  unit: string;
  price_usd: number;
  model: string | null;
  is_active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProviderCost {
  id: string;
  capability: string;
  adapter: string;
  model: string | null;
  unit: string;
  cost_usd: number;
  priority: number;
  latency_class: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface SellRateInput {
  capability: string;
  displayName: string;
  unit: string;
  priceUsd: number;
  model?: string;
  isActive?: boolean;
  sortOrder?: number;
}

export interface ProviderCostInput {
  capability: string;
  adapter: string;
  model?: string;
  unit: string;
  costUsd: number;
  priority?: number;
  latencyClass?: string;
  isActive?: boolean;
}

export interface RateFilters {
  capability?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

export interface ProviderCostFilters {
  capability?: string;
  adapter?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 250;
const DEFAULT_LIMIT = 50;

export class RateStore {
  constructor(private readonly db: DrizzleDb) {}

  // ── Sell Rates ──

  createSellRate(input: SellRateInput): SellRate {
    // Check for existing NULL-model sell rate for this capability (application-level uniqueness)
    if (!input.model) {
      const existing = this.db
        .select({ id: sellRates.id })
        .from(sellRates)
        .where(and(eq(sellRates.capability, input.capability), isNull(sellRates.model)))
        .get();
      if (existing) {
        throw new Error(`A sell rate with capability '${input.capability}' and NULL model already exists`);
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const isActive = input.isActive ?? true;
    const sortOrder = input.sortOrder ?? 0;

    this.db
      .insert(sellRates)
      .values({
        id,
        capability: input.capability,
        displayName: input.displayName,
        unit: input.unit,
        priceUsd: input.priceUsd,
        model: input.model ?? null,
        isActive: isActive ? 1 : 0,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.getSellRate(id) as SellRate;
  }

  updateSellRate(id: string, input: Partial<SellRateInput>): SellRate {
    const existing = this.getSellRate(id);
    if (!existing) {
      throw new Error(`Sell rate with id '${id}' not found`);
    }

    // Check NULL-model uniqueness if changing model to NULL
    if ("model" in input && !input.model) {
      const duplicate = this.db
        .select({ id: sellRates.id })
        .from(sellRates)
        .where(
          and(eq(sellRates.capability, existing.capability), isNull(sellRates.model), sql`${sellRates.id} != ${id}`),
        )
        .get();
      if (duplicate) {
        throw new Error(`A sell rate with capability '${existing.capability}' and NULL model already exists`);
      }
    }

    const setValues: Partial<typeof sellRates.$inferInsert> = {};

    if (input.capability !== undefined) setValues.capability = input.capability;
    if (input.displayName !== undefined) setValues.displayName = input.displayName;
    if (input.unit !== undefined) setValues.unit = input.unit;
    if (input.priceUsd !== undefined) setValues.priceUsd = input.priceUsd;
    if ("model" in input) setValues.model = input.model ?? null;
    if (input.isActive !== undefined) setValues.isActive = input.isActive ? 1 : 0;
    if (input.sortOrder !== undefined) setValues.sortOrder = input.sortOrder;
    setValues.updatedAt = new Date().toISOString();

    this.db.update(sellRates).set(setValues).where(eq(sellRates.id, id)).run();

    return this.getSellRate(id) as SellRate;
  }

  deleteSellRate(id: string): boolean {
    const result = this.db.delete(sellRates).where(eq(sellRates.id, id)).run();
    return result.changes > 0;
  }

  getSellRate(id: string): SellRate | null {
    const row = this.db.select().from(sellRates).where(eq(sellRates.id, id)).get();
    return row ? toSellRate(row) : null;
  }

  /** Look up an active sell rate by capability and model. Returns null if not found. */
  getSellRateByModel(capability: string, model: string, unit?: string): SellRate | null {
    const sqlite = this.db.$client;
    const unitClause = unit ? " AND unit = ?" : "";
    const params: unknown[] = unit ? [capability, model, unit] : [capability, model];
    const result = sqlite
      .prepare(
        `SELECT * FROM sell_rates WHERE capability = ? AND model = ? AND is_active = 1${unitClause} ORDER BY sort_order ASC, created_at ASC LIMIT 1`,
      )
      .get(...params);
    return (result as SellRate) ?? null;
  }

  listSellRates(filters?: RateFilters): { entries: SellRate[]; total: number } {
    const wheres = buildSellRateWheres(filters);

    const countResult = this.db.select({ count: count() }).from(sellRates).where(wheres).get();
    const total = countResult?.count ?? 0;

    const limit = Math.min(filters?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = filters?.offset ?? 0;

    const rows = this.db
      .select()
      .from(sellRates)
      .where(wheres)
      .orderBy(asc(sellRates.capability), asc(sellRates.sortOrder), asc(sellRates.displayName))
      .limit(limit)
      .offset(offset)
      .all();

    return { entries: rows.map(toSellRate), total };
  }

  /** List only active sell rates, ordered by capability + sort_order. For public pricing endpoint. */
  listPublicRates(): SellRate[] {
    const rows = this.db
      .select()
      .from(sellRates)
      .where(eq(sellRates.isActive, 1))
      .orderBy(asc(sellRates.capability), asc(sellRates.sortOrder), asc(sellRates.displayName))
      .all();
    return rows.map(toSellRate);
  }

  // ── Provider Costs ──

  createProviderCost(input: ProviderCostInput): ProviderCost {
    // Check for existing NULL-model provider cost (application-level uniqueness)
    if (!input.model) {
      const existing = this.db
        .select({ id: providerCosts.id })
        .from(providerCosts)
        .where(
          and(
            eq(providerCosts.capability, input.capability),
            eq(providerCosts.adapter, input.adapter),
            isNull(providerCosts.model),
          ),
        )
        .get();
      if (existing) {
        throw new Error(
          `A provider cost with capability '${input.capability}', adapter '${input.adapter}', and NULL model already exists`,
        );
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const isActive = input.isActive ?? true;
    const priority = input.priority ?? 0;
    const latencyClass = input.latencyClass ?? "standard";

    this.db
      .insert(providerCosts)
      .values({
        id,
        capability: input.capability,
        adapter: input.adapter,
        model: input.model ?? null,
        unit: input.unit,
        costUsd: input.costUsd,
        priority,
        latencyClass,
        isActive: isActive ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.getProviderCost(id) as ProviderCost;
  }

  updateProviderCost(id: string, input: Partial<ProviderCostInput>): ProviderCost {
    const existing = this.getProviderCost(id);
    if (!existing) {
      throw new Error(`Provider cost with id '${id}' not found`);
    }

    // Check NULL-model uniqueness if changing model to NULL
    if ("model" in input && !input.model) {
      const duplicate = this.db
        .select({ id: providerCosts.id })
        .from(providerCosts)
        .where(
          and(
            eq(providerCosts.capability, existing.capability),
            eq(providerCosts.adapter, existing.adapter),
            isNull(providerCosts.model),
            sql`${providerCosts.id} != ${id}`,
          ),
        )
        .get();
      if (duplicate) {
        throw new Error(
          `A provider cost with capability '${existing.capability}', adapter '${existing.adapter}', and NULL model already exists`,
        );
      }
    }

    const setValues: Partial<typeof providerCosts.$inferInsert> = {};

    if (input.capability !== undefined) setValues.capability = input.capability;
    if (input.adapter !== undefined) setValues.adapter = input.adapter;
    if ("model" in input) setValues.model = input.model ?? null;
    if (input.unit !== undefined) setValues.unit = input.unit;
    if (input.costUsd !== undefined) setValues.costUsd = input.costUsd;
    if (input.priority !== undefined) setValues.priority = input.priority;
    if (input.latencyClass !== undefined) setValues.latencyClass = input.latencyClass;
    if (input.isActive !== undefined) setValues.isActive = input.isActive ? 1 : 0;
    setValues.updatedAt = new Date().toISOString();

    this.db.update(providerCosts).set(setValues).where(eq(providerCosts.id, id)).run();

    return this.getProviderCost(id) as ProviderCost;
  }

  deleteProviderCost(id: string): boolean {
    const result = this.db.delete(providerCosts).where(eq(providerCosts.id, id)).run();
    return result.changes > 0;
  }

  getProviderCost(id: string): ProviderCost | null {
    const row = this.db.select().from(providerCosts).where(eq(providerCosts.id, id)).get();
    return row ? toProviderCost(row) : null;
  }

  listProviderCosts(filters?: ProviderCostFilters): { entries: ProviderCost[]; total: number } {
    const wheres = buildProviderCostWheres(filters);

    const countResult = this.db.select({ count: count() }).from(providerCosts).where(wheres).get();
    const total = countResult?.count ?? 0;

    const limit = Math.min(filters?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = filters?.offset ?? 0;

    const rows = this.db
      .select()
      .from(providerCosts)
      .where(wheres)
      .orderBy(asc(providerCosts.capability), asc(providerCosts.priority), asc(providerCosts.adapter))
      .limit(limit)
      .offset(offset)
      .all();

    return { entries: rows.map(toProviderCost), total };
  }

  // ── Margin Reporting ──

  /** Get combined sell rate + provider cost for margin calculation */
  getMarginReport(capability?: string): Array<{
    capability: string;
    sellRate: SellRate;
    providerCosts: ProviderCost[];
    bestMarginPct: number;
  }> {
    const wheres = capability ? eq(sellRates.capability, capability) : undefined;

    const allSellRates = this.db
      .select()
      .from(sellRates)
      .where(wheres)
      .orderBy(asc(sellRates.capability), asc(sellRates.sortOrder))
      .all();

    return allSellRates.map((sr) => {
      const costs = this.db
        .select()
        .from(providerCosts)
        .where(eq(providerCosts.capability, sr.capability))
        .orderBy(asc(providerCosts.priority), asc(providerCosts.costUsd))
        .all()
        .map(toProviderCost);

      const sellRate = toSellRate(sr);
      const minCost = costs.length > 0 ? Math.min(...costs.map((pc) => pc.cost_usd)) : 0;
      const bestMarginPct = sellRate.price_usd > 0 ? ((sellRate.price_usd - minCost) / sellRate.price_usd) * 100 : 0;

      return {
        capability: sellRate.capability,
        sellRate,
        providerCosts: costs,
        bestMarginPct,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// WHERE clause builders
// ---------------------------------------------------------------------------

function buildSellRateWheres(filters?: RateFilters) {
  const clauses = [];
  if (filters?.capability) clauses.push(eq(sellRates.capability, filters.capability));
  if (filters?.isActive !== undefined) clauses.push(eq(sellRates.isActive, filters.isActive ? 1 : 0));
  return clauses.length > 0 ? and(...clauses) : undefined;
}

function buildProviderCostWheres(filters?: ProviderCostFilters) {
  const clauses = [];
  if (filters?.capability) clauses.push(eq(providerCosts.capability, filters.capability));
  if (filters?.adapter) clauses.push(eq(providerCosts.adapter, filters.adapter));
  if (filters?.isActive !== undefined) clauses.push(eq(providerCosts.isActive, filters.isActive ? 1 : 0));
  return clauses.length > 0 ? and(...clauses) : undefined;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toSellRate(row: typeof sellRates.$inferSelect): SellRate {
  return {
    id: row.id,
    capability: row.capability,
    display_name: row.displayName,
    unit: row.unit,
    price_usd: row.priceUsd,
    model: row.model,
    is_active: row.isActive,
    sort_order: row.sortOrder,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toProviderCost(row: typeof providerCosts.$inferSelect): ProviderCost {
  return {
    id: row.id,
    capability: row.capability,
    adapter: row.adapter,
    model: row.model,
    unit: row.unit,
    cost_usd: row.costUsd,
    priority: row.priority,
    latency_class: row.latencyClass,
    is_active: row.isActive,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}
