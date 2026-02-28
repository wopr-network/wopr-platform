import crypto from "node:crypto";
import { and, count, eq, gte, isNotNull, isNull, sql, sum } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { affiliateCodes, affiliateReferrals } from "../../db/schema/affiliate.js";
import { Credit } from "../credit.js";

const AFFILIATE_BASE_URL = process.env.AFFILIATE_BASE_URL ?? "https://wopr.network/join?ref=";
const CODE_LENGTH = 6;
const MAX_CODE_ATTEMPTS = 5;

export interface AffiliateCode {
  tenantId: string;
  code: string;
  createdAt: string;
}

export interface AffiliateReferral {
  id: string;
  referrerTenantId: string;
  referredTenantId: string;
  code: string;
  signedUpAt: string;
  firstPurchaseAt: string | null;
  matchAmount: Credit | null;
  matchedAt: string | null;
  payoutSuppressed: boolean;
  suppressionReason: string | null;
  signupIp: string | null;
  signupEmail: string | null;
}

export interface AffiliateStats {
  code: string;
  link: string;
  referrals_total: number;
  referrals_converted: number;
  creditsEarned: Credit;
}

export interface IAffiliateRepository {
  /** Get or create affiliate code for tenant. Generates lazily on first call. */
  getOrCreateCode(tenantId: string): Promise<AffiliateCode>;

  /** Look up which tenant owns a given code. Returns null if code not found. */
  getByCode(code: string): Promise<AffiliateCode | null>;

  /** Record a referral. No-op if referred tenant already attributed. Returns true if new. */
  recordReferral(
    referrerTenantId: string,
    referredTenantId: string,
    code: string,
    signalData?: { signupIp?: string; signupEmail?: string },
  ): Promise<boolean>;

  /** List all referrals where this tenant is the referrer. */
  listByReferrer(referrerTenantId: string): Promise<AffiliateReferral[]>;

  /** Check if a tenant was already referred by someone. */
  isReferred(referredTenantId: string): Promise<boolean>;

  /** Get stats for a tenant's affiliate program. */
  getStats(tenantId: string): Promise<AffiliateStats>;

  /** List referrals for a tenant. */
  listReferrals(tenantId: string): Promise<AffiliateReferral[]>;

  /** Get the referral record for a referred tenant. Returns null if not referred. */
  getReferral(referredTenantId: string): Promise<AffiliateReferral | null>;

  /** Mark a referral as having made first purchase (for conversion tracking). */
  markFirstPurchase(referredTenantId: string): Promise<void>;

  /** Record a match payout on a referral. */
  recordMatch(referredTenantId: string, amount: Credit): Promise<void>;

  /** Look up a referral by the referred tenant. Returns null if not referred. */
  getReferralByReferred(referredTenantId: string): Promise<AffiliateReferral | null>;

  /** Count non-suppressed payouts for a referrer in the last 30 days. */
  getPayoutCount30d(referrerTenantId: string): Promise<number>;

  /** Sum non-suppressed payout amounts (cents) for a referrer in the last 30 days. */
  getPayoutTotal30d(referrerTenantId: string): Promise<number>;

  /** Record a suppressed payout on a referral (no credits granted). */
  recordSuppression(referredTenantId: string, reason: string): Promise<void>;
}

/** Generate a random 6-char lowercase alphanumeric code. */
function generateCode(): string {
  // Use first 10 hex chars of a UUID converted to base36 for a short code
  const uuid = crypto.randomUUID().replace(/-/g, "");
  const num = Number.parseInt(uuid.substring(0, 10), 16);
  return num.toString(36).substring(0, CODE_LENGTH).padEnd(CODE_LENGTH, "0");
}

export class DrizzleAffiliateRepository implements IAffiliateRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getOrCreateCode(tenantId: string): Promise<AffiliateCode> {
    // Check if code already exists
    const existing = (await this.db.select().from(affiliateCodes).where(eq(affiliateCodes.tenantId, tenantId)))[0];

    if (existing) {
      return {
        tenantId: existing.tenantId,
        code: existing.code,
        createdAt: existing.createdAt,
      };
    }

    // Generate a new code with collision retry
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = generateCode();
      try {
        await this.db.insert(affiliateCodes).values({ tenantId, code, createdAt: new Date().toISOString() });

        // Read back to get server-generated createdAt
        const row = (await this.db.select().from(affiliateCodes).where(eq(affiliateCodes.tenantId, tenantId)))[0];
        if (!row) throw new Error("Failed to read back inserted affiliate code");

        return {
          tenantId: row.tenantId,
          code: row.code,
          createdAt: row.createdAt,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        const isUnique =
          msg.includes("UNIQUE") || msg.includes("duplicate key") || (err as { code?: string }).code === "23505";
        // Code collision — retry with a new code
        if (isUnique && (msg.includes("affiliate_codes.code") || msg.includes("affiliate_codes_code_unique"))) continue;
        // Concurrent request won the race on tenant_id — return existing row
        if (isUnique && (msg.includes("affiliate_codes.tenant_id") || msg.includes("affiliate_codes_pkey"))) break;
        throw err;
      }
    }

    // Loop exhausted or broke out of tenant_id race — read back whatever row now exists
    const row = (await this.db.select().from(affiliateCodes).where(eq(affiliateCodes.tenantId, tenantId)))[0];
    if (row) {
      return { tenantId: row.tenantId, code: row.code, createdAt: row.createdAt };
    }

    throw new Error(`Failed to generate unique affiliate code after ${MAX_CODE_ATTEMPTS} attempts`);
  }

  async getByCode(code: string): Promise<AffiliateCode | null> {
    const row = (await this.db.select().from(affiliateCodes).where(eq(affiliateCodes.code, code)))[0];

    if (!row) return null;
    return {
      tenantId: row.tenantId,
      code: row.code,
      createdAt: row.createdAt,
    };
  }

  async recordReferral(
    referrerTenantId: string,
    referredTenantId: string,
    code: string,
    signalData?: { signupIp?: string; signupEmail?: string },
  ): Promise<boolean> {
    if (referrerTenantId === referredTenantId) {
      throw new Error("Self-referral is not allowed");
    }

    const id = crypto.randomUUID();
    const result = await this.db
      .insert(affiliateReferrals)
      .values({
        id,
        referrerTenantId,
        referredTenantId,
        code,
        signupIp: signalData?.signupIp ?? null,
        signupEmail: signalData?.signupEmail ?? null,
      })
      .onConflictDoNothing({ target: affiliateReferrals.referredTenantId })
      .returning({ id: affiliateReferrals.id });

    return result.length > 0;
  }

  async listByReferrer(referrerTenantId: string): Promise<AffiliateReferral[]> {
    const rows = await this.db
      .select()
      .from(affiliateReferrals)
      .where(eq(affiliateReferrals.referrerTenantId, referrerTenantId));
    return rows.map((row) => ({
      id: row.id,
      referrerTenantId: row.referrerTenantId,
      referredTenantId: row.referredTenantId,
      code: row.code,
      signedUpAt: row.signedUpAt,
      firstPurchaseAt: row.firstPurchaseAt,
      matchAmount: row.matchAmountCents != null ? Credit.fromCents(row.matchAmountCents) : null,
      matchedAt: row.matchedAt,
      payoutSuppressed: row.payoutSuppressed,
      suppressionReason: row.suppressionReason,
      signupIp: row.signupIp ?? null,
      signupEmail: row.signupEmail ?? null,
    }));
  }

  async isReferred(referredTenantId: string): Promise<boolean> {
    const row = (
      await this.db
        .select({ id: affiliateReferrals.id })
        .from(affiliateReferrals)
        .where(eq(affiliateReferrals.referredTenantId, referredTenantId))
        .limit(1)
    )[0];

    return row != null;
  }

  async getReferral(referredTenantId: string): Promise<AffiliateReferral | null> {
    const row = (
      await this.db
        .select()
        .from(affiliateReferrals)
        .where(eq(affiliateReferrals.referredTenantId, referredTenantId))
        .limit(1)
    )[0];

    if (!row) return null;
    return {
      id: row.id,
      referrerTenantId: row.referrerTenantId,
      referredTenantId: row.referredTenantId,
      code: row.code,
      signedUpAt: row.signedUpAt,
      firstPurchaseAt: row.firstPurchaseAt,
      matchAmount: row.matchAmountCents != null ? Credit.fromCents(row.matchAmountCents) : null,
      matchedAt: row.matchedAt,
      payoutSuppressed: row.payoutSuppressed,
      suppressionReason: row.suppressionReason,
      signupIp: row.signupIp ?? null,
      signupEmail: row.signupEmail ?? null,
    };
  }

  async getStats(tenantId: string): Promise<AffiliateStats> {
    const codeRow = await this.getOrCreateCode(tenantId);

    const totalRow = (
      await this.db
        .select({ total: count() })
        .from(affiliateReferrals)
        .where(eq(affiliateReferrals.referrerTenantId, tenantId))
    )[0];

    const convertedRow = (
      await this.db
        .select({ converted: count() })
        .from(affiliateReferrals)
        .where(and(eq(affiliateReferrals.referrerTenantId, tenantId), isNotNull(affiliateReferrals.firstPurchaseAt)))
    )[0];

    const earnedRow = (
      await this.db
        .select({ earned: sum(affiliateReferrals.matchAmountCents) })
        .from(affiliateReferrals)
        .where(eq(affiliateReferrals.referrerTenantId, tenantId))
    )[0];

    return {
      code: codeRow.code,
      link: `${AFFILIATE_BASE_URL}${codeRow.code}`,
      referrals_total: totalRow?.total ?? 0,
      referrals_converted: convertedRow?.converted ?? 0,
      creditsEarned: Credit.fromCents(Number(earnedRow?.earned ?? 0)),
    };
  }

  async listReferrals(tenantId: string): Promise<AffiliateReferral[]> {
    const rows = await this.db
      .select()
      .from(affiliateReferrals)
      .where(eq(affiliateReferrals.referrerTenantId, tenantId));
    return rows.map((row) => ({
      id: row.id,
      referrerTenantId: row.referrerTenantId,
      referredTenantId: row.referredTenantId,
      code: row.code,
      signedUpAt: row.signedUpAt,
      firstPurchaseAt: row.firstPurchaseAt,
      matchAmount: row.matchAmountCents != null ? Credit.fromCents(row.matchAmountCents) : null,
      matchedAt: row.matchedAt,
      payoutSuppressed: row.payoutSuppressed,
      suppressionReason: row.suppressionReason,
      signupIp: row.signupIp ?? null,
      signupEmail: row.signupEmail ?? null,
    }));
  }

  async markFirstPurchase(referredTenantId: string): Promise<void> {
    await this.db
      .update(affiliateReferrals)
      .set({ firstPurchaseAt: sql`now()` })
      .where(
        and(eq(affiliateReferrals.referredTenantId, referredTenantId), isNull(affiliateReferrals.firstPurchaseAt)),
      );
  }

  async getReferralByReferred(referredTenantId: string): Promise<AffiliateReferral | null> {
    const row = (
      await this.db.select().from(affiliateReferrals).where(eq(affiliateReferrals.referredTenantId, referredTenantId))
    )[0];

    if (!row) return null;
    return {
      id: row.id,
      referrerTenantId: row.referrerTenantId,
      referredTenantId: row.referredTenantId,
      code: row.code,
      signedUpAt: row.signedUpAt,
      firstPurchaseAt: row.firstPurchaseAt,
      matchAmount: row.matchAmountCents != null ? Credit.fromCents(row.matchAmountCents) : null,
      matchedAt: row.matchedAt,
      payoutSuppressed: row.payoutSuppressed,
      suppressionReason: row.suppressionReason,
      signupIp: row.signupIp ?? null,
      signupEmail: row.signupEmail ?? null,
    };
  }

  async getPayoutCount30d(referrerTenantId: string): Promise<number> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const row = (
      await this.db
        .select({ total: count() })
        .from(affiliateReferrals)
        .where(
          and(
            eq(affiliateReferrals.referrerTenantId, referrerTenantId),
            isNotNull(affiliateReferrals.matchedAt),
            gte(affiliateReferrals.matchedAt, thirtyDaysAgo),
            eq(affiliateReferrals.payoutSuppressed, false),
          ),
        )
    )[0];
    return row?.total ?? 0;
  }

  async getPayoutTotal30d(referrerTenantId: string): Promise<number> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const row = (
      await this.db
        .select({ total: sum(affiliateReferrals.matchAmountCents) })
        .from(affiliateReferrals)
        .where(
          and(
            eq(affiliateReferrals.referrerTenantId, referrerTenantId),
            isNotNull(affiliateReferrals.matchedAt),
            gte(affiliateReferrals.matchedAt, thirtyDaysAgo),
            eq(affiliateReferrals.payoutSuppressed, false),
          ),
        )
    )[0];
    return Number(row?.total ?? 0);
  }

  async recordSuppression(referredTenantId: string, reason: string): Promise<void> {
    await this.db
      .update(affiliateReferrals)
      .set({
        payoutSuppressed: true,
        suppressionReason: reason,
      })
      .where(eq(affiliateReferrals.referredTenantId, referredTenantId));
  }

  async recordMatch(referredTenantId: string, amount: Credit): Promise<void> {
    await this.db
      .update(affiliateReferrals)
      .set({
        matchAmountCents: Math.round(amount.toCents()),
        matchedAt: sql`now()`,
      })
      .where(and(eq(affiliateReferrals.referredTenantId, referredTenantId), isNull(affiliateReferrals.matchedAt)));
  }
}

// Backward-compat alias.
export { DrizzleAffiliateRepository as AffiliateRepository };
