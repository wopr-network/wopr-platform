export type FraudVerdict = "blocked" | "flagged" | "clean";

export interface FraudSignalBundle {
  referrerTenantId: string;
  referredTenantId: string;
  referralId: string;
  referredIp: string | null;
  referredEmail: string | null;
  existingReferrals: Array<{
    referredTenantId: string;
    signupIp: string | null;
    signupEmail: string | null;
  }>;
  referrerIp: string | null;
  referrerEmail: string | null;
  referrerStripeCustomerId: string | null;
  referredStripeCustomerId: string | null;
}

export interface FraudCheckResult {
  verdict: FraudVerdict;
  signals: string[];
  signalDetails: Record<string, string>;
}

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Normalize an email for comparison. Strips Gmail dots and + aliases. */
export function normalizeEmail(email: string | null): string | null {
  if (!email) return null;
  const lower = email.toLowerCase().trim();
  const atIdx = lower.indexOf("@");
  if (atIdx < 0) return lower;

  let local = lower.substring(0, atIdx);
  const domain = lower.substring(atIdx + 1);

  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    const plusIdx = local.indexOf("+");
    if (plusIdx >= 0) local = local.substring(0, plusIdx);
  }

  return `${local}@${domain}`;
}

/**
 * Check a referral for self-referral fraud signals.
 *
 * Pure function — no side effects. Caller decides what to do with the result.
 *
 * Escalation: 0 signals = clean, 1 signal = flagged, 2+ signals = blocked.
 * Exception: same_stripe_customer is always a hard block (1 signal = blocked).
 */
export function checkSelfReferral(bundle: FraudSignalBundle): FraudCheckResult {
  const signals: string[] = [];
  const signalDetails: Record<string, string> = {};

  // Signal 1: Same IP between referrer and referred
  if (bundle.referrerIp && bundle.referredIp && bundle.referrerIp === bundle.referredIp) {
    signals.push("same_ip");
    signalDetails.same_ip = `Both accounts used IP ${bundle.referrerIp}`;
  }

  // Signal 2: Email alias match (normalized comparison)
  const normReferrer = normalizeEmail(bundle.referrerEmail);
  const normReferred = normalizeEmail(bundle.referredEmail);
  if (normReferrer && normReferred && normReferrer === normReferred) {
    signals.push("email_alias");
    signalDetails.email_alias = `Referrer email "${bundle.referrerEmail}" and referred email "${bundle.referredEmail}" normalize to "${normReferrer}"`;
  }

  // Signal 3: Same Stripe customer ID (strongest signal — always block)
  if (
    bundle.referrerStripeCustomerId &&
    bundle.referredStripeCustomerId &&
    bundle.referrerStripeCustomerId === bundle.referredStripeCustomerId
  ) {
    signals.push("same_stripe_customer");
    signalDetails.same_stripe_customer = `Both accounts share Stripe customer ${bundle.referrerStripeCustomerId}`;
  }

  // Signal 4: IP reuse across multiple referrals from same referrer
  if (bundle.referredIp) {
    const reusedWith = bundle.existingReferrals.filter(
      (r) => r.signupIp === bundle.referredIp && r.referredTenantId !== bundle.referredTenantId,
    );
    if (reusedWith.length > 0) {
      signals.push("ip_reuse_across_referrals");
      signalDetails.ip_reuse_across_referrals = `IP ${bundle.referredIp} also used by referred tenants: ${reusedWith.map((r) => r.referredTenantId).join(", ")}`;
    }
  }

  // Signal 5: Email reuse across multiple referrals from same referrer
  if (normReferred) {
    const reusedWith = bundle.existingReferrals.filter((r) => {
      const normExisting = normalizeEmail(r.signupEmail);
      return normExisting === normReferred && r.referredTenantId !== bundle.referredTenantId;
    });
    if (reusedWith.length > 0) {
      signals.push("email_reuse_across_referrals");
      signalDetails.email_reuse_across_referrals = `Normalized email "${normReferred}" also used by referred tenants: ${reusedWith.map((r) => r.referredTenantId).join(", ")}`;
    }
  }

  // Verdict: same_stripe_customer always blocks. Otherwise: 2+ = blocked, 1 = flagged, 0 = clean.
  let verdict: FraudVerdict;
  if (signals.includes("same_stripe_customer")) {
    verdict = "blocked";
  } else if (signals.length >= 2) {
    verdict = "blocked";
  } else if (signals.length === 1) {
    verdict = "flagged";
  } else {
    verdict = "clean";
  }

  return { verdict, signals, signalDetails };
}
