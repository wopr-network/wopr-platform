/**
 * Repository Interface: TenantCustomerRepository (ASYNC)
 * 
 * Manages tenant-to-Stripe customer mappings.
 * This is the bridge between WOPR tenant IDs and Stripe customer IDs.
 */
import type { TenantId } from '../value-objects/tenant-id.js';
import type { TenantCustomer } from '../entities/tenant-customer.js';

export interface TenantCustomerRepository {
  /**
   * Get a tenant's Stripe mapping by tenant ID.
   */
  getByTenant(tenantId: TenantId): Promise<TenantCustomer | null>;

  /**
   * Get a tenant mapping by Stripe customer ID.
   */
  getByStripeCustomerId(stripeCustomerId: string): Promise<TenantCustomer | null>;

  /**
   * Upsert a tenant-to-customer mapping.
   */
  upsert(tenantId: TenantId, stripeCustomerId: string, tier?: string): Promise<void>;

  /**
   * Update the tier for a tenant.
   */
  setTier(tenantId: TenantId, tier: string): Promise<void>;

  /**
   * Set or clear the billing hold flag for a tenant.
   */
  setBillingHold(tenantId: TenantId, hold: boolean): Promise<void>;

  /**
   * Check whether a tenant has an active billing hold.
   */
  hasBillingHold(tenantId: TenantId): Promise<boolean>;

  /**
   * List all tenants with Stripe mappings.
   */
  list(): Promise<TenantCustomer[]>;

  /**
   * Build a tenant -> stripe_customer_id map.
   */
  buildCustomerIdMap(): Promise<Record<string, string>>;
}
