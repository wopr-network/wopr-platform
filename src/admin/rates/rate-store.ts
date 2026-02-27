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
  is_active: boolean;
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
  is_active: boolean;
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

  async createSellRate(input: SellRateInput): Promise<SellRate> {
    // Check for existing NULL-model sell rate for this capability (application-level uniqueness)
    if (!input.model) {
      const existing = (
        await this.db
          .select({ id: sellRates.id })
          .from(sellRates)
          .where(and(eq(sellRates.capability, input.capability), isNull(sellRates.model)))
      )[0];
      if (existing) {
        throw new Error(`A sell rate with capability '${input.capability}' and NULL model already exists`);
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const isActive = input.isActive ?? true;
    const sortOrder = input.sortOrder ?? 0;

    await this.db.insert(sellRates).values({
      id,
      capability: input.capability,
      displayName: input.displayName,
      unit: input.unit,
      priceUsd: input.priceUsd,
      model: input.model ?? null,
      isActive,
      sortOrder,
      createdAt: now,
      updatedAt: now,
    });

    return (await this.getSellRate(id)) as SellRate;
  }

  async updateSellRate(id: string, input: Partial<SellRateInput>): Promise<SellRate> {
    const existing = await this.getSellRate(id);
    if (!existing) {
      throw new Error(`Sell rate with id '${id}' not found`);
    }

    // Check NULL-model uniqueness if changing model to NULL
    if ("model" in input && !input.model) {
      const duplicate = (
        await this.db
          .select({ id: sellRates.id })
          .from(sellRates)
          .where(
            and(eq(sellRates.capability, existing.capability), isNull(sellRates.model), sql`${sellRates.id} != ${id}`),
          )
      )[0];
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
    if (input.isActive !== undefined) setValues.isActive = input.isActive;
    if (input.sortOrder !== undefined) setValues.sortOrder = input.sortOrder;
    setValues.updatedAt = new Date().toISOString();

    await this.db.update(sellRates).set(setValues).where(eq(sellRates.id, id));

    return (await this.getSellRate(id)) as SellRate;
  }

  async deleteSellRate(id: string): Promise<boolean> {
    const result = await this.db.delete(sellRates).where(eq(sellRates.id, id)).returning({ id: sellRates.id });
    return result.length > 0;
  }

  async getSellRate(id: string): Promise<SellRate | null> {
    const rows = await this.db.select().from(sellRates).where(eq(sellRates.id, id));
    return rows[0] ? toSellRate(rows[0]) : null;
  }

  /** Look up an active sell rate by capability and model. Returns null if not found. */
  async getSellRateByModel(capability: string, model: string, unit?: string): Promise<SellRate | null> {
    const conditions = [eq(sellRates.capability, capability), eq(sellRates.model, model), eq(sellRates.isActive, true)];
    if (unit !== undefined) {
      conditions.push(eq(sellRates.unit, unit));
    }
    const rows = await this.db
      .select()
      .from(sellRates)
      .where(and(...conditions))
      .orderBy(asc(sellRates.sortOrder), asc(sellRates.createdAt))
      .limit(1);
    return rows[0] ? toSellRate(rows[0]) : null;
  }

  async listSellRates(filters?: RateFilters): Promise<{ entries: SellRate[]; total: number }> {
    const wheres = buildSellRateWheres(filters);

    const countResult = (await this.db.select({ count: count() }).from(sellRates).where(wheres))[0];
    const total = countResult?.count ?? 0;

    const limit = Math.min(filters?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = filters?.offset ?? 0;

    const rows = await this.db
      .select()
      .from(sellRates)
      .where(wheres)
      .orderBy(asc(sellRates.capability), asc(sellRates.sortOrder), asc(sellRates.displayName))
      .limit(limit)
      .offset(offset);

    return { entries: rows.map(toSellRate), total };
  }

  /** List only active sell rates, ordered by capability + sort_order. For public pricing endpoint. */
  async listPublicRates(): Promise<SellRate[]> {
    const rows = await this.db
      .select()
      .from(sellRates)
      .where(eq(sellRates.isActive, true))
      .orderBy(asc(sellRates.capability), asc(sellRates.sortOrder), asc(sellRates.displayName));
    return rows.map(toSellRate);
  }

  // ── Provider Costs ──

  async createProviderCost(input: ProviderCostInput): Promise<ProviderCost> {
    // Check for existing NULL-model provider cost (application-level uniqueness)
    if (!input.model) {
      const existing = (
        await this.db
          .select({ id: providerCosts.id })
          .from(providerCosts)
          .where(
            and(
              eq(providerCosts.capability, input.capability),
              eq(providerCosts.adapter, input.adapter),
              isNull(providerCosts.model),
            ),
          )
      )[0];
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

    await this.db.insert(providerCosts).values({
      id,
      capability: input.capability,
      adapter: input.adapter,
      model: input.model ?? null,
      unit: input.unit,
      costUsd: input.costUsd,
      priority,
      latencyClass,
      isActive,
      createdAt: now,
      updatedAt: now,
    });

    return (await this.getProviderCost(id)) as ProviderCost;
  }

  async updateProviderCost(id: string, input: Partial<ProviderCostInput>): Promise<ProviderCost> {
    const existing = await this.getProviderCost(id);
    if (!existing) {
      throw new Error(`Provider cost with id '${id}' not found`);
    }

    // Check NULL-model uniqueness if changing model to NULL
    if ("model" in input && !input.model) {
      const duplicate = (
        await this.db
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
      )[0];
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
    if (input.isActive !== undefined) setValues.isActive = input.isActive;
    setValues.updatedAt = new Date().toISOString();

    await this.db.update(providerCosts).set(setValues).where(eq(providerCosts.id, id));

    return (await this.getProviderCost(id)) as ProviderCost;
  }

  async deleteProviderCost(id: string): Promise<boolean> {
    const result = await this.db
      .delete(providerCosts)
      .where(eq(providerCosts.id, id))
      .returning({ id: providerCosts.id });
    return result.length > 0;
  }

  async getProviderCost(id: string): Promise<ProviderCost | null> {
    const rows = await this.db.select().from(providerCosts).where(eq(providerCosts.id, id));
    return rows[0] ? toProviderCost(rows[0]) : null;
  }

  async listProviderCosts(filters?: ProviderCostFilters): Promise<{ entries: ProviderCost[]; total: number }> {
    const wheres = buildProviderCostWheres(filters);

    const countResult = (await this.db.select({ count: count() }).from(providerCosts).where(wheres))[0];
    const total = countResult?.count ?? 0;

    const limit = Math.min(filters?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = filters?.offset ?? 0;

    const rows = await this.db
      .select()
      .from(providerCosts)
      .where(wheres)
      .orderBy(asc(providerCosts.capability), asc(providerCosts.priority), asc(providerCosts.adapter))
      .limit(limit)
      .offset(offset);

    return { entries: rows.map(toProviderCost), total };
  }

  // ── Margin Reporting ──

  /** Get combined sell rate + provider cost for margin calculation */
  async getMarginReport(capability?: string): Promise<
    Array<{
      capability: string;
      sellRate: SellRate;
      providerCosts: ProviderCost[];
      bestMarginPct: number;
    }>
  > {
    const wheres = capability ? eq(sellRates.capability, capability) : undefined;

    const allSellRates = await this.db
      .select()
      .from(sellRates)
      .where(wheres)
      .orderBy(asc(sellRates.capability), asc(sellRates.sortOrder));

    const result = [];
    for (const sr of allSellRates) {
      const costs = (
        await this.db
          .select()
          .from(providerCosts)
          .where(eq(providerCosts.capability, sr.capability))
          .orderBy(asc(providerCosts.priority), asc(providerCosts.costUsd))
      ).map(toProviderCost);

      const sellRate = toSellRate(sr);
      const minCost = costs.length > 0 ? Math.min(...costs.map((pc) => pc.cost_usd)) : 0;
      const bestMarginPct = sellRate.price_usd > 0 ? ((sellRate.price_usd - minCost) / sellRate.price_usd) * 100 : 0;

      result.push({
        capability: sellRate.capability,
        sellRate,
        providerCosts: costs,
        bestMarginPct,
      });
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// WHERE clause builders
// ---------------------------------------------------------------------------

function buildSellRateWheres(filters?: RateFilters) {
  const clauses = [];
  if (filters?.capability) clauses.push(eq(sellRates.capability, filters.capability));
  if (filters?.isActive !== undefined) clauses.push(eq(sellRates.isActive, filters.isActive));
  return clauses.length > 0 ? and(...clauses) : undefined;
}

function buildProviderCostWheres(filters?: ProviderCostFilters) {
  const clauses = [];
  if (filters?.capability) clauses.push(eq(providerCosts.capability, filters.capability));
  if (filters?.adapter) clauses.push(eq(providerCosts.adapter, filters.adapter));
  if (filters?.isActive !== undefined) clauses.push(eq(providerCosts.isActive, filters.isActive));
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
