import { eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { payramCharges } from "../../db/schema/payram.js";
import type { PayRamPaymentState } from "./types.js";

export interface PayRamChargeRecord {
  referenceId: string;
  tenantId: string;
  amountUsdCents: number;
  status: string;
  currency: string | null;
  filledAmount: string | null;
  creditedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IPayRamChargeStore {
  create(referenceId: string, tenantId: string, amountUsdCents: number): Promise<void>;
  getByReferenceId(referenceId: string): Promise<PayRamChargeRecord | null>;
  updateStatus(
    referenceId: string,
    status: PayRamPaymentState,
    currency?: string,
    filledAmount?: string,
  ): Promise<void>;
  markCredited(referenceId: string): Promise<void>;
  isCredited(referenceId: string): Promise<boolean>;
}

/**
 * Manages PayRam charge records in PostgreSQL.
 *
 * Each charge maps a PayRam reference_id to a tenant and tracks
 * the payment lifecycle (OPEN -> VERIFYING -> FILLED/CANCELLED).
 */
export class DrizzlePayRamChargeStore implements IPayRamChargeStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Create a new charge record when a payment session is initiated. */
  async create(referenceId: string, tenantId: string, amountUsdCents: number): Promise<void> {
    await this.db.insert(payramCharges).values({
      referenceId,
      tenantId,
      amountUsdCents,
      status: "OPEN",
    });
  }

  /** Get a charge by reference ID. Returns null if not found. */
  async getByReferenceId(referenceId: string): Promise<PayRamChargeRecord | null> {
    const row = (await this.db.select().from(payramCharges).where(eq(payramCharges.referenceId, referenceId)))[0];
    if (!row) return null;
    return {
      referenceId: row.referenceId,
      tenantId: row.tenantId,
      amountUsdCents: row.amountUsdCents,
      status: row.status,
      currency: row.currency ?? null,
      filledAmount: row.filledAmount ?? null,
      creditedAt: row.creditedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Update charge status and payment details from webhook. */
  async updateStatus(
    referenceId: string,
    status: PayRamPaymentState,
    currency?: string,
    filledAmount?: string,
  ): Promise<void> {
    await this.db
      .update(payramCharges)
      .set({
        status,
        currency,
        filledAmount,
        updatedAt: sql`now()`,
      })
      .where(eq(payramCharges.referenceId, referenceId));
  }

  /** Mark a charge as credited (idempotency flag). */
  async markCredited(referenceId: string): Promise<void> {
    await this.db
      .update(payramCharges)
      .set({
        creditedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(payramCharges.referenceId, referenceId));
  }

  /** Check if a charge has already been credited (for idempotency). */
  async isCredited(referenceId: string): Promise<boolean> {
    const row = (
      await this.db
        .select({ creditedAt: payramCharges.creditedAt })
        .from(payramCharges)
        .where(eq(payramCharges.referenceId, referenceId))
    )[0];
    return row?.creditedAt != null;
  }
}

// Backward-compat alias.
export { DrizzlePayRamChargeStore as PayRamChargeStore };
