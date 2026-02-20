import crypto from "node:crypto";
import type Database from "better-sqlite3";

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
  constructor(private db: Database.Database) {}

  // ── Sell Rates ──

  createSellRate(input: SellRateInput): SellRate {
    // Check for existing NULL-model sell rate for this capability (application-level uniqueness)
    if (!input.model) {
      const existing = this.db
        .prepare("SELECT id FROM sell_rates WHERE capability = ? AND model IS NULL")
        .get(input.capability);
      if (existing) {
        throw new Error(`A sell rate with capability '${input.capability}' and NULL model already exists`);
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const isActive = input.isActive ?? true;
    const sortOrder = input.sortOrder ?? 0;

    this.db
      .prepare(
        `INSERT INTO sell_rates (id, capability, display_name, unit, price_usd, model, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.capability,
        input.displayName,
        input.unit,
        input.priceUsd,
        input.model ?? null,
        isActive ? 1 : 0,
        sortOrder,
        now,
        now,
      );

    const result = this.db.prepare("SELECT * FROM sell_rates WHERE id = ?").get(id) as SellRate;
    return result;
  }

  updateSellRate(id: string, input: Partial<SellRateInput>): SellRate {
    const existing = this.getSellRate(id);
    if (!existing) {
      throw new Error(`Sell rate with id '${id}' not found`);
    }

    // Check NULL-model uniqueness if changing model to NULL
    if ("model" in input && !input.model) {
      const duplicate = this.db
        .prepare("SELECT id FROM sell_rates WHERE capability = ? AND model IS NULL AND id != ?")
        .get(existing.capability, id);
      if (duplicate) {
        throw new Error(`A sell rate with capability '${existing.capability}' and NULL model already exists`);
      }
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (input.capability !== undefined) {
      setClauses.push("capability = ?");
      values.push(input.capability);
    }
    if (input.displayName !== undefined) {
      setClauses.push("display_name = ?");
      values.push(input.displayName);
    }
    if (input.unit !== undefined) {
      setClauses.push("unit = ?");
      values.push(input.unit);
    }
    if (input.priceUsd !== undefined) {
      setClauses.push("price_usd = ?");
      values.push(input.priceUsd);
    }
    if ("model" in input) {
      setClauses.push("model = ?");
      values.push(input.model ?? null);
    }
    if (input.isActive !== undefined) {
      setClauses.push("is_active = ?");
      values.push(input.isActive ? 1 : 0);
    }
    if (input.sortOrder !== undefined) {
      setClauses.push("sort_order = ?");
      values.push(input.sortOrder);
    }

    setClauses.push("updated_at = ?");
    values.push(new Date().toISOString());

    values.push(id);

    this.db.prepare(`UPDATE sell_rates SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);

    const result = this.db.prepare("SELECT * FROM sell_rates WHERE id = ?").get(id) as SellRate;
    return result;
  }

  deleteSellRate(id: string): boolean {
    const result = this.db.prepare("DELETE FROM sell_rates WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getSellRate(id: string): SellRate | null {
    const result = this.db.prepare("SELECT * FROM sell_rates WHERE id = ?").get(id);
    return (result as SellRate) ?? null;
  }

  /** Look up an active sell rate by capability and model. Returns null if not found. */
  getSellRateByModel(capability: string, model: string, unit?: string): SellRate | null {
    const unitClause = unit ? " AND unit = ?" : "";
    const params: unknown[] = unit ? [capability, model, unit] : [capability, model];
    const result = this.db
      .prepare(
        `SELECT * FROM sell_rates WHERE capability = ? AND model = ? AND is_active = 1${unitClause} ORDER BY sort_order ASC, created_at ASC LIMIT 1`,
      )
      .get(...params);
    return (result as SellRate) ?? null;
  }

  listSellRates(filters?: RateFilters): { entries: SellRate[]; total: number } {
    const whereClauses: string[] = [];
    const whereValues: unknown[] = [];

    if (filters?.capability) {
      whereClauses.push("capability = ?");
      whereValues.push(filters.capability);
    }
    if (filters?.isActive !== undefined) {
      whereClauses.push("is_active = ?");
      whereValues.push(filters.isActive ? 1 : 0);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const total = (
      this.db.prepare(`SELECT COUNT(*) as count FROM sell_rates ${whereClause}`).get(...whereValues) as {
        count: number;
      }
    ).count;

    const limit = Math.min(filters?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = filters?.offset ?? 0;

    const entries = this.db
      .prepare(`SELECT * FROM sell_rates ${whereClause} ORDER BY capability, sort_order, display_name LIMIT ? OFFSET ?`)
      .all(...whereValues, limit, offset) as SellRate[];

    return { entries, total };
  }

  /** List only active sell rates, ordered by capability + sort_order. For public pricing endpoint. */
  listPublicRates(): SellRate[] {
    return this.db
      .prepare("SELECT * FROM sell_rates WHERE is_active = 1 ORDER BY capability, sort_order, display_name")
      .all() as SellRate[];
  }

  // ── Provider Costs ──

  createProviderCost(input: ProviderCostInput): ProviderCost {
    // Check for existing NULL-model provider cost (application-level uniqueness)
    if (!input.model) {
      const existing = this.db
        .prepare("SELECT id FROM provider_costs WHERE capability = ? AND adapter = ? AND model IS NULL")
        .get(input.capability, input.adapter);
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
      .prepare(
        `INSERT INTO provider_costs (id, capability, adapter, model, unit, cost_usd, priority, latency_class, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.capability,
        input.adapter,
        input.model ?? null,
        input.unit,
        input.costUsd,
        priority,
        latencyClass,
        isActive ? 1 : 0,
        now,
        now,
      );

    const result = this.db.prepare("SELECT * FROM provider_costs WHERE id = ?").get(id) as ProviderCost;
    return result;
  }

  updateProviderCost(id: string, input: Partial<ProviderCostInput>): ProviderCost {
    const existing = this.getProviderCost(id);
    if (!existing) {
      throw new Error(`Provider cost with id '${id}' not found`);
    }

    // Check NULL-model uniqueness if changing model to NULL
    if ("model" in input && !input.model) {
      const duplicate = this.db
        .prepare("SELECT id FROM provider_costs WHERE capability = ? AND adapter = ? AND model IS NULL AND id != ?")
        .get(existing.capability, existing.adapter, id);
      if (duplicate) {
        throw new Error(
          `A provider cost with capability '${existing.capability}', adapter '${existing.adapter}', and NULL model already exists`,
        );
      }
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (input.capability !== undefined) {
      setClauses.push("capability = ?");
      values.push(input.capability);
    }
    if (input.adapter !== undefined) {
      setClauses.push("adapter = ?");
      values.push(input.adapter);
    }
    if ("model" in input) {
      setClauses.push("model = ?");
      values.push(input.model ?? null);
    }
    if (input.unit !== undefined) {
      setClauses.push("unit = ?");
      values.push(input.unit);
    }
    if (input.costUsd !== undefined) {
      setClauses.push("cost_usd = ?");
      values.push(input.costUsd);
    }
    if (input.priority !== undefined) {
      setClauses.push("priority = ?");
      values.push(input.priority);
    }
    if (input.latencyClass !== undefined) {
      setClauses.push("latency_class = ?");
      values.push(input.latencyClass);
    }
    if (input.isActive !== undefined) {
      setClauses.push("is_active = ?");
      values.push(input.isActive ? 1 : 0);
    }

    setClauses.push("updated_at = ?");
    values.push(new Date().toISOString());

    values.push(id);

    this.db.prepare(`UPDATE provider_costs SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);

    const result = this.db.prepare("SELECT * FROM provider_costs WHERE id = ?").get(id) as ProviderCost;
    return result;
  }

  deleteProviderCost(id: string): boolean {
    const result = this.db.prepare("DELETE FROM provider_costs WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getProviderCost(id: string): ProviderCost | null {
    const result = this.db.prepare("SELECT * FROM provider_costs WHERE id = ?").get(id);
    return (result as ProviderCost) ?? null;
  }

  listProviderCosts(filters?: ProviderCostFilters): { entries: ProviderCost[]; total: number } {
    const whereClauses: string[] = [];
    const whereValues: unknown[] = [];

    if (filters?.capability) {
      whereClauses.push("capability = ?");
      whereValues.push(filters.capability);
    }
    if (filters?.adapter) {
      whereClauses.push("adapter = ?");
      whereValues.push(filters.adapter);
    }
    if (filters?.isActive !== undefined) {
      whereClauses.push("is_active = ?");
      whereValues.push(filters.isActive ? 1 : 0);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const total = (
      this.db.prepare(`SELECT COUNT(*) as count FROM provider_costs ${whereClause}`).get(...whereValues) as {
        count: number;
      }
    ).count;

    const limit = Math.min(filters?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = filters?.offset ?? 0;

    const entries = this.db
      .prepare(`SELECT * FROM provider_costs ${whereClause} ORDER BY capability, priority, adapter LIMIT ? OFFSET ?`)
      .all(...whereValues, limit, offset) as ProviderCost[];

    return { entries, total };
  }

  // ── Margin Reporting ──

  /** Get combined sell rate + provider cost for margin calculation */
  getMarginReport(capability?: string): Array<{
    capability: string;
    sellRate: SellRate;
    providerCosts: ProviderCost[];
    bestMarginPct: number;
  }> {
    const whereClauses: string[] = [];
    const whereValues: unknown[] = [];

    if (capability) {
      whereClauses.push("sr.capability = ?");
      whereValues.push(capability);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const sellRatesQuery = `SELECT * FROM sell_rates sr ${whereClause} ORDER BY sr.capability, sr.sort_order`;
    const sellRates = this.db.prepare(sellRatesQuery).all(...whereValues) as SellRate[];

    return sellRates.map((sellRate) => {
      const providerCosts = this.db
        .prepare("SELECT * FROM provider_costs WHERE capability = ? ORDER BY priority, cost_usd")
        .all(sellRate.capability) as ProviderCost[];

      const minCost = providerCosts.length > 0 ? Math.min(...providerCosts.map((pc) => pc.cost_usd)) : 0;
      const bestMarginPct = sellRate.price_usd > 0 ? ((sellRate.price_usd - minCost) / sellRate.price_usd) * 100 : 0;

      return {
        capability: sellRate.capability,
        sellRate,
        providerCosts,
        bestMarginPct,
      };
    });
  }
}
