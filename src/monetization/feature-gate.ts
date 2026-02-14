import type { Context, Next } from "hono";
import type { CreditLedger } from "./credits/credit-ledger.js";

/**
 * Callback to resolve the user's current credit balance in cents.
 */
export type GetUserBalance = (tenantId: string) => number | Promise<number>;

export interface FeatureGateConfig {
  /** Resolve the authenticated tenant's credit balance in cents */
  getUserBalance: GetUserBalance;
  /** Key on the Hono context where the authenticated user object lives (default: "user") */
  userKey?: string;
  /** Property on the user object that holds the tenant ID (default: "id") */
  userIdField?: string;
}

/**
 * Create a `requireBalance` middleware factory.
 *
 * Usage:
 * ```ts
 * const { requireBalance } = createFeatureGate({
 *   getUserBalance: (tenantId) => creditLedger.balance(tenantId),
 * });
 * app.post('/api/bots', requireAuth, requireBalance(), handler);
 * ```
 */
export function createFeatureGate(cfg: FeatureGateConfig) {
  const userKey = cfg.userKey ?? "user";
  const userIdField = cfg.userIdField ?? "id";

  /**
   * Middleware that rejects requests when the user's credit balance is zero.
   * Optionally requires a minimum balance (in cents).
   * On success, sets `c.set('balance', balanceCents)` for downstream handlers.
   */
  const requireBalance = (minBalanceCents = 0) => {
    return async (c: Context, next: Next) => {
      const user = c.get(userKey) as Record<string, unknown> | undefined;
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const tenantId = user[userIdField] as string | undefined;
      if (!tenantId) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const balanceCents = await cfg.getUserBalance(tenantId);

      if (balanceCents <= minBalanceCents) {
        return c.json(
          {
            error: "Insufficient credit balance",
            currentBalanceCents: balanceCents,
            requiredBalanceCents: minBalanceCents,
            purchaseUrl: "/settings/billing",
          },
          402,
        );
      }

      c.set("balance", balanceCents);
      return next();
    };
  };

  return { requireBalance };
}

/**
 * Convenience factory that creates a requireBalance middleware from a CreditLedger instance.
 */
export function createBalanceGate(ledger: CreditLedger, userKey?: string, userIdField?: string) {
  return createFeatureGate({
    getUserBalance: (tenantId) => ledger.balance(tenantId),
    userKey,
    userIdField,
  });
}
