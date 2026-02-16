/**
 * Domain Entity: CreditBalance
 *
 * Immutable representation of a tenant's current credit balance.
 */
import { Money } from "../value-objects/money.js";
import type { TenantId } from "../value-objects/tenant-id.js";

export interface CreditBalanceProps {
  tenantId: TenantId;
  balance: Money;
  lastUpdated: Date;
}

export class CreditBalance {
  constructor(private readonly props: CreditBalanceProps) {}

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get balance(): Money {
    return this.props.balance;
  }

  get lastUpdated(): Date {
    return this.props.lastUpdated;
  }

  /**
   * Create a zero balance for a tenant.
   */
  static zero(tenantId: TenantId): CreditBalance {
    return new CreditBalance({
      tenantId,
      balance: Money.zero(),
      lastUpdated: new Date(),
    });
  }

  /**
   * Add credits to this balance.
   */
  credit(amount: Money): CreditBalance {
    return new CreditBalance({
      tenantId: this.props.tenantId,
      balance: this.props.balance.add(amount),
      lastUpdated: new Date(),
    });
  }

  /**
   * Subtract credits from this balance.
   * @throws InsufficientFundsError if amount exceeds balance
   */
  debit(amount: Money): CreditBalance {
    return new CreditBalance({
      tenantId: this.props.tenantId,
      balance: this.props.balance.subtract(amount),
      lastUpdated: new Date(),
    });
  }

  /**
   * Check if balance is zero.
   */
  isZero(): boolean {
    return this.props.balance.toCents() === 0;
  }

  toJSON() {
    return {
      tenantId: this.props.tenantId.toJSON(),
      balanceCents: this.props.balance.toCents(),
      lastUpdated: this.props.lastUpdated.toISOString(),
    };
  }
}
