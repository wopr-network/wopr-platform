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
  create(referenceId: string, tenantId: string, amountUsdCents: number): void;
  getByReferenceId(referenceId: string): PayRamChargeRecord | null;
  updateStatus(referenceId: string, status: PayRamPaymentState, currency?: string, filledAmount?: string): void;
  markCredited(referenceId: string): void;
  isCredited(referenceId: string): boolean;
}

/**
 * Manages PayRam charge records in SQLite.
 *
 * Each charge maps a PayRam reference_id to a tenant and tracks
 * the payment lifecycle (OPEN -> VERIFYING -> FILLED/CANCELLED).
 */
export class DrizzlePayRamChargeStore implements IPayRamChargeStore {
  constructor(private readonly db: DrizzleDb) {}

  /** Create a new charge record when a payment session is initiated. */
  create(referenceId: string, tenantId: string, amountUsdCents: number): void {
    this.db
      .insert(payramCharges)
      .values({
        referenceId,
        tenantId,
        amountUsdCents,
        status: "OPEN",
      })
      .run();
  }

  /** Get a charge by reference ID. Returns null if not found. */
  getByReferenceId(referenceId: string): PayRamChargeRecord | null {
    const row = this.db.select().from(payramCharges).where(eq(payramCharges.referenceId, referenceId)).get();
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
  updateStatus(referenceId: string, status: PayRamPaymentState, currency?: string, filledAmount?: string): void {
    this.db
      .update(payramCharges)
      .set({
        status,
        currency,
        filledAmount,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(payramCharges.referenceId, referenceId))
      .run();
  }

  /** Mark a charge as credited (idempotency flag). */
  markCredited(referenceId: string): void {
    this.db
      .update(payramCharges)
      .set({
        creditedAt: sql`(datetime('now'))`,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(payramCharges.referenceId, referenceId))
      .run();
  }

  /** Check if a charge has already been credited (for idempotency). */
  isCredited(referenceId: string): boolean {
    const row = this.db
      .select({ creditedAt: payramCharges.creditedAt })
      .from(payramCharges)
      .where(eq(payramCharges.referenceId, referenceId))
      .get();
    return row?.creditedAt != null;
  }
}

// Backward-compat alias.
export { DrizzlePayRamChargeStore as PayRamChargeStore };
