import type { TenantId } from '../value-objects/tenant-id.js';

export interface TenantCustomerProps {
  tenantId: TenantId;
  stripeCustomerId: string;
  tier: string;
  billingHold: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class TenantCustomer {
  private constructor(private readonly props: TenantCustomerProps) {}

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get stripeCustomerId(): string {
    return this.props.stripeCustomerId;
  }

  get tier(): string {
    return this.props.tier;
  }

  get billingHold(): boolean {
    return this.props.billingHold;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  isOnHold(): boolean {
    return this.props.billingHold;
  }

  static create(props: {
    tenantId: TenantId;
    stripeCustomerId: string;
    tier?: string;
  }): TenantCustomer {
    const now = new Date();
    return new TenantCustomer({
      tenantId: props.tenantId,
      stripeCustomerId: props.stripeCustomerId,
      tier: props.tier ?? 'free',
      billingHold: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  withUpdatedTier(tier: string): TenantCustomer {
    return new TenantCustomer({
      ...this.props,
      tier,
      updatedAt: new Date(),
    });
  }

  withBillingHold(hold: boolean): TenantCustomer {
    return new TenantCustomer({
      ...this.props,
      billingHold: hold,
      updatedAt: new Date(),
    });
  }

  toJSON() {
    return {
      tenantId: this.props.tenantId.toString(),
      stripeCustomerId: this.props.stripeCustomerId,
      tier: this.props.tier,
      billingHold: this.props.billingHold,
      createdAt: this.props.createdAt.toISOString(),
      updatedAt: this.props.updatedAt.toISOString(),
    };
  }
}
