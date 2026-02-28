import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { affiliateFraudEvents } from "../../db/schema/affiliate-fraud.js";

export interface FraudEventInput {
  referralId: string;
  referrerTenantId: string;
  referredTenantId: string;
  verdict: "blocked" | "flagged" | "clean";
  signals: string[];
  signalDetails: Record<string, string>;
  phase: "signup" | "payout";
}

export interface FraudEvent extends FraudEventInput {
  id: string;
  createdAt: string;
}

export interface IAffiliateFraudRepository {
  record(input: FraudEventInput): Promise<void>;
  listByReferrer(referrerTenantId: string): Promise<FraudEvent[]>;
  isBlocked(referralId: string, phase: string): Promise<boolean>;
}

export class DrizzleAffiliateFraudRepository implements IAffiliateFraudRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(input: FraudEventInput): Promise<void> {
    const id = crypto.randomUUID();
    await this.db
      .insert(affiliateFraudEvents)
      .values({
        id,
        referralId: input.referralId,
        referrerTenantId: input.referrerTenantId,
        referredTenantId: input.referredTenantId,
        verdict: input.verdict,
        signals: JSON.stringify(input.signals),
        signalDetails: JSON.stringify(input.signalDetails),
        phase: input.phase,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing();
  }

  async listByReferrer(referrerTenantId: string): Promise<FraudEvent[]> {
    const rows = await this.db
      .select()
      .from(affiliateFraudEvents)
      .where(eq(affiliateFraudEvents.referrerTenantId, referrerTenantId));

    return rows.map((r) => ({
      id: r.id,
      referralId: r.referralId,
      referrerTenantId: r.referrerTenantId,
      referredTenantId: r.referredTenantId,
      verdict: r.verdict as "blocked" | "flagged" | "clean",
      signals: JSON.parse(r.signals) as string[],
      signalDetails: JSON.parse(r.signalDetails) as Record<string, string>,
      phase: r.phase as "signup" | "payout",
      createdAt: r.createdAt,
    }));
  }

  async isBlocked(referralId: string, phase: string): Promise<boolean> {
    const row = (
      await this.db
        .select({ id: affiliateFraudEvents.id })
        .from(affiliateFraudEvents)
        .where(
          and(
            eq(affiliateFraudEvents.referralId, referralId),
            eq(affiliateFraudEvents.phase, phase),
            eq(affiliateFraudEvents.verdict, "blocked"),
          ),
        )
        .limit(1)
    )[0];
    return row != null;
  }
}
