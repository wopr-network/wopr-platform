import { Credit } from "../credit.js";
import type { ICreditLedger } from "./credit-ledger.js";

/** Signup grant amount: $5.00 */
export const SIGNUP_GRANT = Credit.fromDollars(5);

/**
 * Grant the signup credit bonus to a newly verified tenant.
 *
 * Idempotent: uses `signup:<tenantId>` as referenceId to prevent double-grants.
 *
 * @returns true if the grant was applied, false if already granted.
 */
export async function grantSignupCredits(ledger: ICreditLedger, tenantId: string): Promise<boolean> {
  const refId = `signup:${tenantId}`;

  // Idempotency check
  if (await ledger.hasReferenceId(refId)) {
    return false;
  }

  try {
    await ledger.credit(
      tenantId,
      SIGNUP_GRANT,
      "signup_grant",
      "Welcome bonus — $5.00 credit on email verification",
      refId,
    );
  } catch (err) {
    // Concurrent verify-email request won the race and already inserted the same referenceId.
    // Treat unique constraint violation as a no-op (idempotent).
    if (isUniqueConstraintViolation(err)) return false;
    throw err;
  }

  return true;
}

function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as { code?: string }).code === "23505") return true;
  return err.message.includes("UNIQUE") || err.message.includes("duplicate key");
}

/** @deprecated use SIGNUP_GRANT */
export const SIGNUP_GRANT_CENTS = SIGNUP_GRANT.toCents();
