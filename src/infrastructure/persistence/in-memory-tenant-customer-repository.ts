/**
 * In-Memory Implementation: TenantCustomerRepository (ASYNC)
 *
 * For fast unit testing without database.
 */

import { TenantCustomer } from "../../domain/entities/tenant-customer.js";
import type { TenantCustomerRepository } from "../../domain/repositories/tenant-customer-repository.js";
import type { TenantId } from "../../domain/value-objects/tenant-id.js";

interface StoredCustomer {
  tenant: string;
  stripeCustomerId: string;
  tier: string;
  billingHold: number;
  createdAt: number;
  updatedAt: number;
}

export class InMemoryTenantCustomerRepository implements TenantCustomerRepository {
  private customers = new Map<string, StoredCustomer>();
  private stripeIdIndex = new Map<string, string>();

  async getByTenant(tenantId: TenantId): Promise<TenantCustomer | null> {
    const customer = this.customers.get(tenantId.toString());
    return customer ? this.toTenantCustomer(customer) : null;
  }

  async getByStripeCustomerId(stripeCustomerId: string): Promise<TenantCustomer | null> {
    const tenant = this.stripeIdIndex.get(stripeCustomerId);
    if (!tenant) return null;
    const customer = this.customers.get(tenant);
    return customer ? this.toTenantCustomer(customer) : null;
  }

  async upsert(tenantId: TenantId, stripeCustomerId: string, tier?: string): Promise<void> {
    const tenantStr = tenantId.toString();
    const now = Date.now();
    const existing = this.customers.get(tenantStr);

    const customer: StoredCustomer = {
      tenant: tenantStr,
      stripeCustomerId,
      tier: tier ?? existing?.tier ?? "free",
      billingHold: existing?.billingHold ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.customers.set(tenantStr, customer);
    this.stripeIdIndex.set(stripeCustomerId, tenantStr);
  }

  async setTier(tenantId: TenantId, tier: string): Promise<void> {
    const customer = this.customers.get(tenantId.toString());
    if (!customer) return;

    this.customers.set(tenantId.toString(), {
      ...customer,
      tier,
      updatedAt: Date.now(),
    });
  }

  async setBillingHold(tenantId: TenantId, hold: boolean): Promise<void> {
    const customer = this.customers.get(tenantId.toString());
    if (!customer) return;

    this.customers.set(tenantId.toString(), {
      ...customer,
      billingHold: hold ? 1 : 0,
      updatedAt: Date.now(),
    });
  }

  async hasBillingHold(tenantId: TenantId): Promise<boolean> {
    const customer = this.customers.get(tenantId.toString());
    return customer?.billingHold === 1;
  }

  async list(): Promise<TenantCustomer[]> {
    const sorted = Array.from(this.customers.values()).sort((a, b) => b.createdAt - a.createdAt);
    return sorted.map(this.toTenantCustomer);
  }

  async buildCustomerIdMap(): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    for (const [tenant, customer] of this.customers) {
      map[tenant] = customer.stripeCustomerId;
    }
    return map;
  }

  clear(): void {
    this.customers.clear();
    this.stripeIdIndex.clear();
  }

  private toTenantCustomer(customer: StoredCustomer): TenantCustomer {
    return TenantCustomer.fromRow({
      tenant: customer.tenant,
      stripeCustomerId: customer.stripeCustomerId,
      tier: customer.tier,
      billingHold: customer.billingHold,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    });
  }
}
