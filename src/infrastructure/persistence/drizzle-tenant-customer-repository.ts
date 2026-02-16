/**
 * Drizzle Implementation: TenantCustomerRepository (ASYNC API)
 *
 * better-sqlite3 is synchronous, but we expose async API.
 */
import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { tenantCustomers } from "../../db/schema/stripe.js";
import { TenantCustomer } from "../../domain/entities/tenant-customer.js";
import type { TenantCustomerRepository } from "../../domain/repositories/tenant-customer-repository.js";
import type { TenantId } from "../../domain/value-objects/tenant-id.js";

function rowToTenantCustomer(row: typeof tenantCustomers.$inferSelect): TenantCustomer {
  return TenantCustomer.fromRow({
    tenant: row.tenant,
    stripeCustomerId: row.stripeCustomerId,
    tier: row.tier,
    billingHold: row.billingHold,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export class DrizzleTenantCustomerRepository implements TenantCustomerRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByTenant(tenantId: TenantId): Promise<TenantCustomer | null> {
    const row = this.db.select().from(tenantCustomers).where(eq(tenantCustomers.tenant, tenantId.toString())).get();

    return row ? rowToTenantCustomer(row) : null;
  }

  async getByStripeCustomerId(stripeCustomerId: string): Promise<TenantCustomer | null> {
    const row = this.db
      .select()
      .from(tenantCustomers)
      .where(eq(tenantCustomers.stripeCustomerId, stripeCustomerId))
      .get();

    return row ? rowToTenantCustomer(row) : null;
  }

  async upsert(tenantId: TenantId, stripeCustomerId: string, tier?: string): Promise<void> {
    const now = Date.now();
    this.db
      .insert(tenantCustomers)
      .values({
        tenant: tenantId.toString(),
        stripeCustomerId,
        tier: tier ?? "free",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tenantCustomers.tenant,
        set: {
          stripeCustomerId,
          tier: tier !== undefined ? tier : undefined,
          updatedAt: now,
        },
      })
      .run();
  }

  async setTier(tenantId: TenantId, tier: string): Promise<void> {
    this.db
      .update(tenantCustomers)
      .set({ tier, updatedAt: Date.now() })
      .where(eq(tenantCustomers.tenant, tenantId.toString()))
      .run();
  }

  async setBillingHold(tenantId: TenantId, hold: boolean): Promise<void> {
    this.db
      .update(tenantCustomers)
      .set({ billingHold: hold ? 1 : 0, updatedAt: Date.now() })
      .where(eq(tenantCustomers.tenant, tenantId.toString()))
      .run();
  }

  async hasBillingHold(tenantId: TenantId): Promise<boolean> {
    const row = this.db
      .select({ billingHold: tenantCustomers.billingHold })
      .from(tenantCustomers)
      .where(eq(tenantCustomers.tenant, tenantId.toString()))
      .get();

    return row?.billingHold === 1;
  }

  async list(): Promise<TenantCustomer[]> {
    const rows = this.db.select().from(tenantCustomers).orderBy(desc(tenantCustomers.createdAt)).all();

    return rows.map(rowToTenantCustomer);
  }

  async buildCustomerIdMap(): Promise<Record<string, string>> {
    const rows = this.db
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
