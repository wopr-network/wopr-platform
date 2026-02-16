import crypto from "node:crypto";
import type {
  AdjustmentFilters,
  AdjustmentType,
  CreditAdjustment,
  CreditAdjustmentRepository,
} from "../../domain/repositories/credit-adjustment-repository.js";

const MAX_LIMIT = 250;
const DEFAULT_LIMIT = 50;

export class InMemoryCreditAdjustmentRepository implements CreditAdjustmentRepository {
  private readonly adjustments: CreditAdjustment[] = [];

  async grant(
    tenant: string,
    amountCents: number,
    reason: string,
    adminUser: string,
    referenceIds?: string[],
  ): Promise<CreditAdjustment> {
    if (amountCents <= 0) throw new Error("amount_cents must be positive for grants");
    if (!reason.trim()) throw new Error("reason is required");

    const refIds = referenceIds && referenceIds.length > 0 ? JSON.stringify(referenceIds) : null;
    return this.insert(tenant, "grant", amountCents, reason, adminUser, refIds);
  }

  async refund(
    tenant: string,
    amountCents: number,
    reason: string,
    adminUser: string,
    referenceIds?: string[],
  ): Promise<CreditAdjustment> {
    if (amountCents <= 0) throw new Error("amount_cents must be positive for refunds");
    if (!reason.trim()) throw new Error("reason is required");

    const refIds = referenceIds && referenceIds.length > 0 ? JSON.stringify(referenceIds) : null;

    const balance = await this.getBalance(tenant);
    if (balance - amountCents < 0) {
      throw new BalanceError(
        `Insufficient balance: current ${balance} cents, requested refund ${amountCents} cents`,
        balance,
      );
    }

    return this.insert(tenant, "refund", -amountCents, reason, adminUser, refIds);
  }

  async correction(tenant: string, amountCents: number, reason: string, adminUser: string): Promise<CreditAdjustment> {
    if (!reason.trim()) throw new Error("reason is required");

    if (amountCents < 0) {
      const balance = await this.getBalance(tenant);
      if (balance + amountCents < 0) {
        throw new BalanceError(
          `Correction would result in negative balance: current ${balance} cents, correction ${amountCents} cents`,
          balance,
        );
      }
    }

    return this.insert(tenant, "correction", amountCents, reason, adminUser, null);
  }

  async getBalance(tenant: string): Promise<number> {
    const tenantAdjustments = this.adjustments.filter((a) => a.tenant === tenant);
    return tenantAdjustments.reduce((sum, a) => sum + a.amount_cents, 0);
  }

  async listTransactions(
    tenant: string,
    filters: AdjustmentFilters = {},
  ): Promise<{ entries: CreditAdjustment[]; total: number }> {
    let results = this.adjustments.filter((a) => a.tenant === tenant);

    if (filters.type) {
      results = results.filter((a) => a.type === filters.type);
    }

    const from = filters.from;
    if (from != null) {
      results = results.filter((a) => a.created_at >= from);
    }

    const to = filters.to;
    if (to != null) {
      results = results.filter((a) => a.created_at <= to);
    }

    const total = results.length;

    results.sort((a, b) => b.created_at - a.created_at);

    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);
    const entries = results.slice(offset, offset + limit);

    return { entries, total };
  }

  async getTransaction(transactionId: string): Promise<CreditAdjustment | null> {
    return this.adjustments.find((a) => a.id === transactionId) ?? null;
  }

  async hasReferenceId(referenceId: string): Promise<boolean> {
    return this.adjustments.some((a) => a.reference_ids?.includes(referenceId) ?? false);
  }

  private insert(
    tenant: string,
    type: AdjustmentType,
    amountCents: number,
    reason: string,
    adminUser: string,
    referenceIds: string | null,
  ): CreditAdjustment {
    const row: CreditAdjustment = {
      id: crypto.randomUUID(),
      tenant,
      type,
      amount_cents: amountCents,
      reason,
      admin_user: adminUser,
      reference_ids: referenceIds,
      created_at: Date.now(),
    };

    this.adjustments.push(row);
    return row;
  }

  reset(): void {
    this.adjustments.length = 0;
  }
}

export class BalanceError extends Error {
  currentBalance: number;

  constructor(message: string, currentBalance: number) {
    super(message);
    this.name = "BalanceError";
    this.currentBalance = currentBalance;
  }
}
