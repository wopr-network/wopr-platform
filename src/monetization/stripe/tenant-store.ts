import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { tenantCustomers } from "../../db/schema/tenant-customers.js";
import type { TenantCustomerRow } from "./types.js";

export interface ITenantCustomerStore {
  getByTenant(tenant: string): TenantCustomerRow | null;
  getByProcessorCustomerId(processorCustomerId: string): TenantCustomerRow | null;
  upsert(row: { tenant: string; processorCustomerId: string; tier?: string }): void;
  setTier(tenant: string, tier: string): void;
  setBillingHold(tenant: string, hold: boolean): void;
  hasBillingHold(tenant: string): boolean;
  getInferenceMode(tenant: string): string;
  setInferenceMode(tenant: string, mode: string): void;
  list(): TenantCustomerRow[];
  buildCustomerIdMap(): Record<string, string>;
}

/**
 * Manages tenant-to-payment-processor customer mappings in SQLite.
 *
 * This is the bridge between WOPR tenant IDs and processor customer IDs.
 * All billing operations look up the processor customer via this store.
 *
 * Note: No subscription tracking — WOPR uses credits, not subscriptions.
 * Credit balances are managed by CreditAdjustmentStore.
 */
export class DrizzleTenantCustomerStore implements ITenantCustomerStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Get a tenant's processor mapping. */
  getByTenant(tenant: string): TenantCustomerRow | null {
    const row = this.db.select().from(tenantCustomers).where(eq(tenantCustomers.tenant, tenant)).get();
    return row ? mapRow(row) : null;
  }

  /** Get a tenant mapping by processor customer ID. */
  getByProcessorCustomerId(processorCustomerId: string): TenantCustomerRow | null {
    const row = this.db
      .select()
      .from(tenantCustomers)
      .where(eq(tenantCustomers.processorCustomerId, processorCustomerId))
      .get();
    return row ? mapRow(row) : null;
  }

  /** Upsert a tenant-to-customer mapping. */
  upsert(row: { tenant: string; processorCustomerId: string; tier?: string }): void {
    const now = Date.now();
    this.db
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
      })
      .run();
  }

  /** Update the tier for a tenant. */
  setTier(tenant: string, tier: string): void {
    this.db
      .update(tenantCustomers)
      .set({ tier, updatedAt: Date.now() })
      .where(eq(tenantCustomers.tenant, tenant))
      .run();
  }

  /** Set or clear the billing hold flag for a tenant. */
  setBillingHold(tenant: string, hold: boolean): void {
    this.db
      .update(tenantCustomers)
      .set({ billingHold: hold ? 1 : 0, updatedAt: Date.now() })
      .where(eq(tenantCustomers.tenant, tenant))
      .run();
  }

  /** Check whether a tenant has an active billing hold. */
  hasBillingHold(tenant: string): boolean {
    const row = this.db
      .select({ billingHold: tenantCustomers.billingHold })
      .from(tenantCustomers)
      .where(eq(tenantCustomers.tenant, tenant))
      .get();
    return row?.billingHold === 1;
  }

  /** Get inference mode for a tenant (defaults to "byok"). */
  getInferenceMode(tenant: string): string {
    const row = this.db
      .select({ inferenceMode: tenantCustomers.inferenceMode })
      .from(tenantCustomers)
      .where(eq(tenantCustomers.tenant, tenant))
      .get();
    return row?.inferenceMode ?? "byok";
  }

  /** Set inference mode for a tenant. */
  setInferenceMode(tenant: string, mode: string): void {
    this.db
      .update(tenantCustomers)
      .set({ inferenceMode: mode, updatedAt: Date.now() })
      .where(eq(tenantCustomers.tenant, tenant))
      .run();
  }

  /** List all tenants with processor mappings. */
  list(): TenantCustomerRow[] {
    const rows = this.db.select().from(tenantCustomers).orderBy(desc(tenantCustomers.createdAt)).all();
    return rows.map(mapRow);
  }

  /** Build a tenant -> processor_customer_id map for use with UsageAggregationWorker. */
  buildCustomerIdMap(): Record<string, string> {
    const rows = this.db
      .select({
        tenant: tenantCustomers.tenant,
        processorCustomerId: tenantCustomers.processorCustomerId,
      })
      .from(tenantCustomers)
      .all();

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
