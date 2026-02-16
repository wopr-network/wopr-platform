/**
 * Domain Entity: CreditTransaction
 * 
 * Immutable record of a credit change (credit or debit).
 */
import type { TenantId } from '../value-objects/tenant-id.js';
import type { Money } from '../value-objects/money.js';
import type { TransactionId } from '../value-objects/transaction-id.js';

export type CreditType = 'signup_grant' | 'purchase' | 'bounty' | 'referral' | 'promo';
export type DebitType = 'bot_runtime' | 'adapter_usage' | 'addon' | 'refund' | 'correction';
export type TransactionType = CreditType | DebitType;

export interface CreditTransactionProps {
  id: TransactionId;
  tenantId: TenantId;
  amount: Money;
  balanceAfter: Money;
  type: TransactionType;
  description: string | null;
  referenceId: string | null;
  createdAt: Date;
}

export class CreditTransaction {
  constructor(private readonly props: CreditTransactionProps) {}

  get id(): TransactionId {
    return this.props.id;
  }

  get tenantId(): TenantId {
    return this.props.tenantId;
  }

  get amount(): Money {
    return this.props.amount;
  }

  get balanceAfter(): Money {
    return this.props.balanceAfter;
  }

  get type(): TransactionType {
    return this.props.type;
  }

  get description(): string | null {
    return this.props.description;
  }

  get referenceId(): string | null {
    return this.props.referenceId;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  /**
   * Check if this is a credit (positive change).
   */
  isCredit(): boolean {
    return ['signup_grant', 'purchase', 'bounty', 'referral', 'promo'].includes(this.props.type);
  }

  /**
   * Check if this is a debit (negative change).
   */
  isDebit(): boolean {
    return !this.isCredit();
  }

  toJSON() {
    return {
      id: this.props.id.toJSON(),
      tenantId: this.props.tenantId.toJSON(),
      amountCents: this.props.amount.toCents(),
      balanceAfterCents: this.props.balanceAfter.toCents(),
      type: this.props.type,
      description: this.props.description,
      referenceId: this.props.referenceId,
      createdAt: this.props.createdAt.toISOString(),
    };
  }
}
