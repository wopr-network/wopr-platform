import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { tenantCustomers } from "../../db/schema/tenant-customers.js";
import type { TenantCustomerRow } from "./types.js";

export interface ITenantCustomerStore {
  getByTenant(tenant: string): Promise<TenantCustomerRow | null>;
  getByProcessorCustomerId(processorCustomerId: string): Promise<TenantCustomerRow | null>;
  upsert(row: { tenant: string; processorCustomerId: string; tier?: string }): Promise<void>;
  setTier(tenant: string, tier: string): Promise<void>;
  setBillingHold(tenant: string, hold: boolean): Promise<void>;
  hasBillingHold(tenant: string): Promise<boolean>;
  getInferenceMode(tenant: string): Promise<string>;
  setInferenceMode(tenant: string, mode: string): Promise<void>;
  list(): Promise<TenantCustomerRow[]>;
  buildCustomerIdMap(): Promise<Record<string, string>>;
}

/**
 * Manages tenant-to-payment-processor customer mappings in PostgreSQL.
 *
 * This is the bridge between WOPR tenant IDs and processor customer IDs.
 * All billing operations look up the processor customer via this store.
 *
 * Note: No subscription tracking — WOPR uses credits, not subscriptions.
 * Credit balances are managed by ICreditLedger / DrizzleCreditLedger.
 */
export class DrizzleTenantCustomerStore implements ITenantCustomerStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Get a tenant's processor mapping. */
  async getByTenant(tenant: string): Promise<TenantCustomerRow | null> {
    const row = (await this.db.select().from(tenantCustomers).where(eq(tenantCustomers.tenant, tenant)))[0];
    return row ? mapRow(row) : null;
  }

  /** Get a tenant mapping by processor customer ID. */
  async getByProcessorCustomerId(processorCustomerId: string): Promise<TenantCustomerRow | null> {
    const row = (
      await this.db.select().from(tenantCustomers).where(eq(tenantCustomers.processorCustomerId, processorCustomerId))
    )[0];
    return row ? mapRow(row) : null;
  }

  /** Upsert a tenant-to-customer mapping. */
  async upsert(row: { tenant: string; processorCustomerId: string; tier?: string }): Promise<void> {
    const now = Date.now();
    await this.db
      .insert(tenantCustomers)
      .values({
        tenant: row.tenant,
        processorCustomerId: row.processorCustomerId,
        tier: row.tier ?? "free",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tenantCustomers.tenant,
        set: {
          processorCustomerId: row.processorCustomerId,
          tier: row.tier !== undefined ? row.tier : undefined,
          updatedAt: now,
        },
      });
  }

  /** Update the tier for a tenant. */
  async setTier(tenant: string, tier: string): Promise<void> {
    await this.db
      .update(tenantCustomers)
      .set({ tier, updatedAt: Date.now() })
      .where(eq(tenantCustomers.tenant, tenant));
  }

  /** Set or clear the billing hold flag for a tenant. */
  async setBillingHold(tenant: string, hold: boolean): Promise<void> {
    await this.db
      .update(tenantCustomers)
      .set({ billingHold: hold ? 1 : 0, updatedAt: Date.now() })
      .where(eq(tenantCustomers.tenant, tenant));
  }

  /** Check whether a tenant has an active billing hold. */
  async hasBillingHold(tenant: string): Promise<boolean> {
    const row = (
      await this.db
        .select({ billingHold: tenantCustomers.billingHold })
        .from(tenantCustomers)
        .where(eq(tenantCustomers.tenant, tenant))
    )[0];
    return row?.billingHold === 1;
  }

  /** Get inference mode for a tenant (defaults to "byok"). */
  async getInferenceMode(tenant: string): Promise<string> {
    const row = (
      await this.db
        .select({ inferenceMode: tenantCustomers.inferenceMode })
        .from(tenantCustomers)
        .where(eq(tenantCustomers.tenant, tenant))
    )[0];
    return row?.inferenceMode ?? "byok";
  }

  /** Set inference mode for a tenant. */
  async setInferenceMode(tenant: string, mode: string): Promise<void> {
    await this.db
      .update(tenantCustomers)
      .set({ inferenceMode: mode, updatedAt: Date.now() })
      .where(eq(tenantCustomers.tenant, tenant));
  }

  /** List all tenants with processor mappings. */
  async list(): Promise<TenantCustomerRow[]> {
    const rows = await this.db.select().from(tenantCustomers).orderBy(desc(tenantCustomers.createdAt));
    return rows.map(mapRow);
  }

  /** Build a tenant -> processor_customer_id map for use with UsageAggregationWorker. */
  async buildCustomerIdMap(): Promise<Record<string, string>> {
    const rows = await this.db
      .select({
        tenant: tenantCustomers.tenant,
        processorCustomerId: tenantCustomers.processorCustomerId,
      })
      .from(tenantCustomers);

    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.tenant] = row.processorCustomerId;
    }
    return map;
  }
}

/** Map a Drizzle row to the TenantCustomerRow interface (snake_case field names). */
function mapRow(row: typeof tenantCustomers.$inferSelect): TenantCustomerRow {
  return {
    tenant: row.tenant,
    processor_customer_id: row.processorCustomerId,
    processor: row.processor,
    tier: row.tier,
    billing_hold: row.billingHold,
    inference_mode: row.inferenceMode,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// Backward-compat alias.
export { DrizzleTenantCustomerStore as TenantCustomerStore };
