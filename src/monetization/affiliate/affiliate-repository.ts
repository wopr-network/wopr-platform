import crypto from "node:crypto";
import { and, count, eq, isNotNull, sql, sum } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { affiliateCodes, affiliateReferrals } from "../../db/schema/affiliate.js";

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
  matchAmountCents: number | null;
  matchedAt: string | null;
}

export interface AffiliateStats {
  code: string;
  link: string;
  referrals_total: number;
  referrals_converted: number;
  credits_earned_cents: number;
}

export interface IAffiliateRepository {
  /** Get or create affiliate code for tenant. Generates lazily on first call. */
  getOrCreateCode(tenantId: string): AffiliateCode;

  /** Look up which tenant owns a given code. Returns null if code not found. */
  getByCode(code: string): AffiliateCode | null;

  /** Record a referral. No-op if referred tenant already attributed. Returns true if new. */
  recordReferral(referrerTenantId: string, referredTenantId: string, code: string): boolean;

  /** Check if a tenant was already referred by someone. */
  isReferred(referredTenantId: string): boolean;

  /** Get stats for a tenant's affiliate program. */
  getStats(tenantId: string): AffiliateStats;

  /** List referrals for a tenant. */
  listReferrals(tenantId: string): AffiliateReferral[];

  /** Mark a referral as having made first purchase (for conversion tracking). */
  markFirstPurchase(referredTenantId: string): void;

  /** Record a match payout on a referral. */
  recordMatch(referredTenantId: string, amountCents: number): void;
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

  getOrCreateCode(tenantId: string): AffiliateCode {
    // Check if code already exists
    const existing = this.db.select().from(affiliateCodes).where(eq(affiliateCodes.tenantId, tenantId)).get();

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
        this.db.insert(affiliateCodes).values({ tenantId, code }).run();

        // Read back to get server-generated createdAt
        const row = this.db.select().from(affiliateCodes).where(eq(affiliateCodes.tenantId, tenantId)).get();
        if (!row) throw new Error("Failed to read back inserted affiliate code");

        return {
          tenantId: row.tenantId,
          code: row.code,
          createdAt: row.createdAt,
        };
      } catch (err) {
        // If it's a UNIQUE constraint violation on code, retry
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("UNIQUE") && msg.includes("code")) continue;
        throw err;
      }
    }

    throw new Error(`Failed to generate unique affiliate code after ${MAX_CODE_ATTEMPTS} attempts`);
  }

  getByCode(code: string): AffiliateCode | null {
    const row = this.db.select().from(affiliateCodes).where(eq(affiliateCodes.code, code)).get();

    if (!row) return null;
    return {
      tenantId: row.tenantId,
      code: row.code,
      createdAt: row.createdAt,
    };
  }

  recordReferral(referrerTenantId: string, referredTenantId: string, code: string): boolean {
    if (referrerTenantId === referredTenantId) {
      throw new Error("Self-referral is not allowed");
    }

    const id = crypto.randomUUID();
    try {
      const result = this.db
        .insert(affiliateReferrals)
        .values({ id, referrerTenantId, referredTenantId, code })
        .onConflictDoNothing({ target: affiliateReferrals.referredTenantId })
        .run();

      // SQLite returns changes=0 if onConflictDoNothing triggered
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  isReferred(referredTenantId: string): boolean {
    const row = this.db
      .select({ id: affiliateReferrals.id })
      .from(affiliateReferrals)
      .where(eq(affiliateReferrals.referredTenantId, referredTenantId))
      .limit(1)
      .get();

    return row != null;
  }

  getStats(tenantId: string): AffiliateStats {
    const codeRow = this.getOrCreateCode(tenantId);

    const totalRow = this.db
      .select({ total: count() })
      .from(affiliateReferrals)
      .where(eq(affiliateReferrals.referrerTenantId, tenantId))
      .get();

    const convertedRow = this.db
      .select({ converted: count() })
      .from(affiliateReferrals)
      .where(and(eq(affiliateReferrals.referrerTenantId, tenantId), isNotNull(affiliateReferrals.firstPurchaseAt)))
      .get();

    const earnedRow = this.db
      .select({ earned: sum(affiliateReferrals.matchAmountCents) })
      .from(affiliateReferrals)
      .where(eq(affiliateReferrals.referrerTenantId, tenantId))
      .get();

    return {
      code: codeRow.code,
      link: `${AFFILIATE_BASE_URL}${codeRow.code}`,
      referrals_total: totalRow?.total ?? 0,
      referrals_converted: convertedRow?.converted ?? 0,
      credits_earned_cents: Number(earnedRow?.earned ?? 0),
    };
  }

  listReferrals(tenantId: string): AffiliateReferral[] {
    return this.db
      .select()
      .from(affiliateReferrals)
      .where(eq(affiliateReferrals.referrerTenantId, tenantId))
      .all()
      .map((row) => ({
        id: row.id,
        referrerTenantId: row.referrerTenantId,
        referredTenantId: row.referredTenantId,
        code: row.code,
        signedUpAt: row.signedUpAt,
        firstPurchaseAt: row.firstPurchaseAt,
        matchAmountCents: row.matchAmountCents,
        matchedAt: row.matchedAt,
      }));
  }

  markFirstPurchase(referredTenantId: string): void {
    this.db
      .update(affiliateReferrals)
      .set({ firstPurchaseAt: sql`(datetime('now'))` })
      .where(eq(affiliateReferrals.referredTenantId, referredTenantId))
      .run();
  }

  recordMatch(referredTenantId: string, amountCents: number): void {
    this.db
      .update(affiliateReferrals)
      .set({
        matchAmountCents: amountCents,
        matchedAt: sql`(datetime('now'))`,
      })
      .where(eq(affiliateReferrals.referredTenantId, referredTenantId))
      .run();
  }
}

// Backward-compat alias.
export { DrizzleAffiliateRepository as AffiliateRepository };
