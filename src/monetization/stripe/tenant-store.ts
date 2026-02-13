import type Database from "better-sqlite3";
import type { TenantCustomerRow } from "./types.js";

/**
 * Manages tenant-to-Stripe customer mappings in SQLite.
 *
 * This is the bridge between WOPR tenant IDs and Stripe customer IDs.
 * All billing operations look up the Stripe customer via this store.
 */
export class TenantCustomerStore {
  constructor(private readonly db: Database.Database) {}

  /** Get a tenant's Stripe mapping. */
  getByTenant(tenant: string): TenantCustomerRow | null {
    return (
      (this.db.prepare("SELECT * FROM tenant_customers WHERE tenant = ?").get(tenant) as
        | TenantCustomerRow
        | undefined) ?? null
    );
  }

  /** Get a tenant mapping by Stripe customer ID. */
  getByStripeCustomerId(stripeCustomerId: string): TenantCustomerRow | null {
    return (
      (this.db.prepare("SELECT * FROM tenant_customers WHERE stripe_customer_id = ?").get(stripeCustomerId) as
        | TenantCustomerRow
        | undefined) ?? null
    );
  }

  /** Upsert a tenant-to-customer mapping. */
  upsert(row: { tenant: string; stripeCustomerId: string; stripeSubscriptionId?: string | null; tier?: string }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO tenant_customers (tenant, stripe_customer_id, stripe_subscription_id, tier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant) DO UPDATE SET
           stripe_customer_id = excluded.stripe_customer_id,
           stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, tenant_customers.stripe_subscription_id),
           tier = COALESCE(excluded.tier, tenant_customers.tier),
           updated_at = excluded.updated_at`,
      )
      .run(row.tenant, row.stripeCustomerId, row.stripeSubscriptionId ?? null, row.tier ?? "free", now, now);
  }

  /** Update the subscription ID for a tenant. Pass null to clear. */
  setSubscription(tenant: string, subscriptionId: string | null): void {
    this.db
      .prepare("UPDATE tenant_customers SET stripe_subscription_id = ?, updated_at = ? WHERE tenant = ?")
      .run(subscriptionId, Date.now(), tenant);
  }

  /** Update the tier for a tenant. */
  setTier(tenant: string, tier: string): void {
    this.db
      .prepare("UPDATE tenant_customers SET tier = ?, updated_at = ? WHERE tenant = ?")
      .run(tier, Date.now(), tenant);
  }

  /** List all tenants with Stripe mappings. */
  list(): TenantCustomerRow[] {
    return this.db.prepare("SELECT * FROM tenant_customers ORDER BY created_at DESC").all() as TenantCustomerRow[];
  }

  /** Build a tenant -> stripe_customer_id map for use with UsageAggregationWorker. */
  buildCustomerIdMap(): Record<string, string> {
    const rows = this.db.prepare("SELECT tenant, stripe_customer_id FROM tenant_customers").all() as Array<{
      tenant: string;
      stripe_customer_id: string;
    }>;

    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.tenant] = row.stripe_customer_id;
    }
    return map;
  }
}
