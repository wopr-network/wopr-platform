import { Credit } from "../credit.js";
import type { CreditLedger } from "./credit-ledger.js";

/** Signup grant amount: $5.00 */
export const SIGNUP_GRANT = Credit.fromDollars(5);

/**
 * Grant the signup credit bonus to a newly verified tenant.
 *
 * Idempotent: uses `signup:<tenantId>` as referenceId to prevent double-grants.
 *
 * @returns true if the grant was applied, false if already granted.
 */
export async function grantSignupCredits(ledger: CreditLedger, tenantId: string): Promise<boolean> {
  const refId = `signup:${tenantId}`;

  // Idempotency check
  if (await ledger.hasReferenceId(refId)) {
    return false;
  }

  await ledger.credit(
    tenantId,
    SIGNUP_GRANT,
    "signup_grant",
    "Welcome bonus — $5.00 credit on email verification",
    refId,
  );

  return true;
}

/** @deprecated use SIGNUP_GRANT */
export const SIGNUP_GRANT_CENTS = SIGNUP_GRANT.toCents();
