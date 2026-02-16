import type { CreditRepository } from "../../domain/repositories/credit-repository.js";
import { TenantId } from "../../domain/value-objects/tenant-id.js";
import { Money } from "../../domain/value-objects/money.js";

/** Signup grant amount: $5.00 = 500 cents */
export const SIGNUP_GRANT_CENTS = 500;

/**
 * Grant the signup credit bonus to a newly verified tenant.
 *
 * Idempotent: uses `signup:<tenantId>` as referenceId to prevent double-grants.
 *
 * @returns true if the grant was applied, false if already granted.
 */
export async function grantSignupCredits(repo: CreditRepository, tenantId: string): Promise<boolean> {
  const refId = `signup:${tenantId}`;

  if (await repo.hasReferenceId(refId)) {
    return false;
  }

  await repo.credit(
    TenantId.create(tenantId),
    Money.fromCents(SIGNUP_GRANT_CENTS),
    "signup_grant",
    "Welcome bonus — $5.00 credit on email verification",
    refId,
  );

  return true;
}
