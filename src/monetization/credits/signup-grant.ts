import type { CreditLedger } from "./credit-ledger.js";

/** Signup grant amount: $5.00 = 500 cents */
export const SIGNUP_GRANT_CENTS = 500;

/**
 * Grant the signup credit bonus to a newly verified tenant.
 *
 * Idempotent: uses `signup:<tenantId>` as referenceId to prevent double-grants.
 *
 * @returns true if the grant was applied, false if already granted.
 */
export function grantSignupCredits(ledger: CreditLedger, tenantId: string): boolean {
  const refId = `signup:${tenantId}`;

  // Idempotency check
  if (ledger.hasReferenceId(refId)) {
    return false;
  }

  ledger.credit(
    tenantId,
    SIGNUP_GRANT_CENTS,
    "signup_grant",
    "Welcome bonus — $5.00 credit on email verification",
    refId,
  );

  return true;
}
