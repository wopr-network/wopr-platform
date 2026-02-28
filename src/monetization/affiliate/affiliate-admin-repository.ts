import crypto from "node:crypto";
import { and, count, desc, gte, isNotNull, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { affiliateReferrals } from "../../db/schema/affiliate.js";
import { affiliateFraudEvents } from "../../db/schema/affiliate-fraud.js";

export interface SuppressionEvent {
  id: string;
  referrerTenantId: string;
  referredTenantId: string;
  verdict: string;
  signals: string[];
  signalDetails: Record<string, string>;
  phase: string;
  createdAt: string;
}

export interface VelocityReferrer {
  referrerTenantId: string;
  payoutCount30d: number;
  payoutTotal30d: number;
}

export interface FingerprintCluster {
  stripeFingerprint: string;
  tenantIds: string[];
}

export interface IAffiliateFraudAdminRepository {
  listSuppressions(limit: number, offset: number): Promise<{ events: SuppressionEvent[]; total: number }>;
  listVelocityReferrers(capReferrals: number, capCredits: number): Promise<VelocityReferrer[]>;
  listFingerprintClusters(): Promise<FingerprintCluster[]>;
  blockFingerprint(fingerprint: string, adminUserId: string): Promise<void>;
}

export class DrizzleAffiliateFraudAdminRepository implements IAffiliateFraudAdminRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listSuppressions(limit: number, offset: number): Promise<{ events: SuppressionEvent[]; total: number }> {
    const [rows, totalRows] = await Promise.all([
      this.db
        .select()
        .from(affiliateFraudEvents)
        .where(sql`${affiliateFraudEvents.verdict} = 'blocked'`)
        .orderBy(desc(affiliateFraudEvents.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(affiliateFraudEvents)
        .where(sql`${affiliateFraudEvents.verdict} = 'blocked'`),
    ]);

    return {
      events: rows.map((r) => ({
        id: r.id,
        referrerTenantId: r.referrerTenantId,
        referredTenantId: r.referredTenantId,
        verdict: r.verdict,
        signals: JSON.parse(r.signals) as string[],
        signalDetails: JSON.parse(r.signalDetails) as Record<string, string>,
        phase: r.phase,
        createdAt: r.createdAt,
      })),
      total: totalRows[0]?.total ?? 0,
    };
  }

  async listVelocityReferrers(capReferrals: number, capCredits: number): Promise<VelocityReferrer[]> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const rows = await this.db
      .select({
        referrerTenantId: affiliateReferrals.referrerTenantId,
        payoutCount30d: count(),
        payoutTotal30d: sql<number>`COALESCE(SUM(${affiliateReferrals.matchAmountCents}), 0)`,
      })
      .from(affiliateReferrals)
      .where(and(isNotNull(affiliateReferrals.matchedAt), gte(affiliateReferrals.matchedAt, thirtyDaysAgo)))
      .groupBy(affiliateReferrals.referrerTenantId)
      .orderBy(desc(count()));

    // capReferrals and capCredits are used by callers for display thresholds,
    // not for SQL filtering — return all referrers with 30d activity
    void capReferrals;
    void capCredits;

    return rows.map((r) => ({
      referrerTenantId: r.referrerTenantId,
      payoutCount30d: r.payoutCount30d,
      payoutTotal30d: Number(r.payoutTotal30d),
    }));
  }

  async listFingerprintClusters(): Promise<FingerprintCluster[]> {
    // raw SQL: Drizzle cannot express HAVING COUNT(DISTINCT ...) with array_agg on a column
    // that may not yet exist in the typed schema (stripe_fingerprint added by WOP-1061 migration)
    type ClusterRow = { stripe_fingerprint: string; tenant_ids: string[] };
    const rows = (await this.db.execute(sql`
      SELECT stripe_fingerprint, array_agg(DISTINCT tenant_id ORDER BY tenant_id) AS tenant_ids
      FROM credit_transactions
      WHERE stripe_fingerprint IS NOT NULL
      GROUP BY stripe_fingerprint
      HAVING COUNT(DISTINCT tenant_id) > 1
      ORDER BY COUNT(DISTINCT tenant_id) DESC
    `)) as unknown as { rows: ClusterRow[] };

    return rows.rows.map((r) => ({
      stripeFingerprint: r.stripe_fingerprint,
      tenantIds: r.tenant_ids,
    }));
  }

  async blockFingerprint(fingerprint: string, adminUserId: string): Promise<void> {
    // raw SQL: Drizzle cannot express DISTINCT on a column not yet in the typed schema
    type TenantRow = { tenant_id: string };
    const tenantRows = (await this.db.execute(sql`
      SELECT DISTINCT tenant_id FROM credit_transactions
      WHERE stripe_fingerprint = ${fingerprint}
    `)) as unknown as { rows: TenantRow[] };
    const tenantIds = tenantRows.rows.map((r) => r.tenant_id);

    const now = new Date().toISOString();
    for (const tenantId of tenantIds) {
      const id = crypto.randomUUID();
      await this.db
        .insert(affiliateFraudEvents)
        .values({
          id,
          referralId: `admin_block:${fingerprint}`,
          referrerTenantId: tenantId,
          referredTenantId: tenantId,
          verdict: "blocked",
          signals: JSON.stringify(["admin_fingerprint_block"]),
          signalDetails: JSON.stringify({
            admin_fingerprint_block: `Fingerprint ${fingerprint} blocked by admin ${adminUserId}. Cluster: ${tenantIds.join(", ")}`,
          }),
          phase: "admin",
          createdAt: now,
        })
        .onConflictDoNothing();
    }
  }
}
