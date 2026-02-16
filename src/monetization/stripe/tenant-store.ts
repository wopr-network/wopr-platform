import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { tenantCustomers } from "../../db/schema/stripe.js";
import type { TenantCustomerRow } from "./types.js";

/**
 * Manages tenant-to-Stripe customer mappings in SQLite.
 *
 * This is the bridge between WOPR tenant IDs and Stripe customer IDs.
 * All billing operations look up the Stripe customer via this store.
 *
 * Note: No subscription tracking — WOPR uses credits, not subscriptions.
 * Credit balances are managed by CreditAdjustmentStore.
 *
 * All methods are async for future database flexibility.
 */
export class TenantCustomerStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Get a tenant's Stripe mapping. */
  async getByTenant(tenant: string): Promise<TenantCustomerRow | null> {
    const row = await this.db.select().from(tenantCustomers).where(eq(tenantCustomers.tenant, tenant)).get();
    return row ? mapRow(row) : null;
  }

  /** Get a tenant mapping by Stripe customer ID. */
  async getByStripeCustomerId(stripeCustomerId: string): Promise<TenantCustomerRow | null> {
    const row = await this.db
      .select()
      .from(tenantCustomers)
      .where(eq(tenantCustomers.stripeCustomerId, stripeCustomerId))
      .get();
    return row ? mapRow(row) : null;
  }

  /** Upsert a tenant-to-customer mapping. */
  async upsert(row: { tenant: string; stripeCustomerId: string; tier?: string }): Promise<void> {
    const now = Date.now();
    await this.db
      .insert(tenantCustomers)
      .values({
        tenant: row.tenant,
        stripeCustomerId: row.stripeCustomerId,
        tier: row.tier ?? "free",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tenantCustomers.tenant,
        set: {
          stripeCustomerId: row.stripeCustomerId,
          tier: row.tier !== undefined ? row.tier : undefined,
          updatedAt: now,
        },
      })
      .run();
  }

  /** Update the tier for a tenant. */
  async setTier(tenant: string, tier: string): Promise<void> {
    await this.db
      .update(tenantCustomers)
      .set({ tier, updatedAt: Date.now() })
      .where(eq(tenantCustomers.tenant, tenant))
      .run();
  }

  /** Set or clear the billing hold flag for a tenant. */
  async setBillingHold(tenant: string, hold: boolean): Promise<void> {
    await this.db
      .update(tenantCustomers)
      .set({ billingHold: hold ? 1 : 0, updatedAt: Date.now() })
      .where(eq(tenantCustomers.tenant, tenant))
      .run();
  }

  /** Check whether a tenant has an active billing hold. */
  async hasBillingHold(tenant: string): Promise<boolean> {
    const row = await this.db
      .select({ billingHold: tenantCustomers.billingHold })
      .from(tenantCustomers)
      .where(eq(tenantCustomers.tenant, tenant))
      .get();
    return row?.billingHold === 1;
  }

  /** List all tenants with Stripe mappings. */
  async list(): Promise<TenantCustomerRow[]> {
    const rows = await this.db.select().from(tenantCustomers).orderBy(desc(tenantCustomers.createdAt)).all();
    return rows.map(mapRow);
  }

  /** Build a tenant -> stripe_customer_id map for use with UsageAggregationWorker. */
  async buildCustomerIdMap(): Promise<Record<string, string>> {
    const rows = await this.db
      .select({
        tenant: tenantCustomers.tenant,
        stripeCustomerId: tenantCustomers.stripeCustomerId,
      })
      .from(tenantCustomers)
      .all();

    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.tenant] = row.stripeCustomerId;
    }
    return map;
  }
}

/** Map a Drizzle row to the TenantCustomerRow interface (snake_case field names). */
function mapRow(row: typeof tenantCustomers.$inferSelect): TenantCustomerRow {
  return {
    tenant: row.tenant,
    stripe_customer_id: row.stripeCustomerId,
    tier: row.tier,
    billing_hold: row.billingHold,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}
