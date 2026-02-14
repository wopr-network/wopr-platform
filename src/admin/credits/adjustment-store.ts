import crypto from "node:crypto";
import type Database from "better-sqlite3";

export type AdjustmentType = "grant" | "refund" | "correction";

export interface CreditAdjustment {
  id: string;
  tenant: string;
  type: AdjustmentType;
  amount_cents: number;
  reason: string;
  admin_user: string;
  reference_ids: string | null;
  created_at: number;
}

export interface AdjustmentFilters {
  type?: AdjustmentType;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 250;
const DEFAULT_LIMIT = 50;

export class CreditAdjustmentStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO credit_adjustments (id, tenant, type, amount_cents, reason, admin_user, reference_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /** Grant credits to a tenant. amount_cents must be positive. */
  grant(tenant: string, amountCents: number, reason: string, adminUser: string): CreditAdjustment {
    if (amountCents <= 0) throw new Error("amount_cents must be positive for grants");
    if (!reason.trim()) throw new Error("reason is required");

    return this.insert(tenant, "grant", amountCents, reason, adminUser, null);
  }

  /** Refund credits to a tenant. amount_cents must be positive. Balance must not go negative. */
  refund(
    tenant: string,
    amountCents: number,
    reason: string,
    adminUser: string,
    referenceIds?: string[],
  ): CreditAdjustment {
    if (amountCents <= 0) throw new Error("amount_cents must be positive for refunds");
    if (!reason.trim()) throw new Error("reason is required");

    const balance = this.getBalance(tenant);
    if (balance - amountCents < 0) {
      throw new BalanceError(
        `Insufficient balance: current ${balance} cents, requested refund ${amountCents} cents`,
        balance,
      );
    }

    const refIds = referenceIds && referenceIds.length > 0 ? JSON.stringify(referenceIds) : null;
    return this.insert(tenant, "refund", -amountCents, reason, adminUser, refIds);
  }

  /** Apply a balance correction. amount_cents is signed (positive adds, negative removes). */
  correction(tenant: string, amountCents: number, reason: string, adminUser: string): CreditAdjustment {
    if (!reason.trim()) throw new Error("reason is required");

    if (amountCents < 0) {
      const balance = this.getBalance(tenant);
      if (balance + amountCents < 0) {
        throw new BalanceError(
          `Correction would result in negative balance: current ${balance} cents, correction ${amountCents} cents`,
          balance,
        );
      }
    }

    return this.insert(tenant, "correction", amountCents, reason, adminUser, null);
  }

  /** Get the current balance for a tenant in cents. */
  getBalance(tenant: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(amount_cents), 0) as balance FROM credit_adjustments WHERE tenant = ?")
      .get(tenant) as { balance: number };
    return row.balance;
  }

  /** List all transactions for a tenant with optional filters and pagination. */
  listTransactions(tenant: string, filters: AdjustmentFilters = {}): { entries: CreditAdjustment[]; total: number } {
    const conditions: string[] = ["tenant = ?"];
    const params: unknown[] = [tenant];

    if (filters.type) {
      conditions.push("type = ?");
      params.push(filters.type);
    }

    if (filters.from != null) {
      conditions.push("created_at >= ?");
      params.push(filters.from);
    }

    if (filters.to != null) {
      conditions.push("created_at <= ?");
      params.push(filters.to);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM credit_adjustments ${where}`).get(...params) as {
      count: number;
    };
    const total = countRow.count;

    const limit = Math.min(Math.max(1, filters.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const offset = Math.max(0, filters.offset ?? 0);

    const entries = this.db
      .prepare(`SELECT * FROM credit_adjustments ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as CreditAdjustment[];

    return { entries, total };
  }

  /** Get a single transaction by ID. */
  getTransaction(transactionId: string): CreditAdjustment | null {
    const row = this.db.prepare("SELECT * FROM credit_adjustments WHERE id = ?").get(transactionId) as
      | CreditAdjustment
      | undefined;
    return row ?? null;
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

    this.insertStmt.run(
      row.id,
      row.tenant,
      row.type,
      row.amount_cents,
      row.reason,
      row.admin_user,
      row.reference_ids,
      row.created_at,
    );

    return row;
  }
}

/** Error thrown when a balance check fails. Includes the current balance. */
export class BalanceError extends Error {
  currentBalance: number;

  constructor(message: string, currentBalance: number) {
    super(message);
    this.name = "BalanceError";
    this.currentBalance = currentBalance;
  }
}
