import type { ISessionUsageRepository } from "./session-usage-repository.js";

export type BudgetTier = "anonymous" | "free" | "paid";

const BUDGET_CAPS_USD: Record<BudgetTier, number> = {
  anonymous: 0.1,
  free: 0.25,
  paid: 1.0,
};

export interface BudgetCheckResult {
  allowed: boolean;
  remainingUsd: number;
  capUsd: number;
}

export async function checkSessionBudget(
  repo: ISessionUsageRepository,
  sessionId: string,
  tier: BudgetTier,
): Promise<BudgetCheckResult> {
  const cap = BUDGET_CAPS_USD[tier];
  const spent = await repo.sumCostBySession(sessionId);
  const remaining = cap - spent;
  return {
    allowed: remaining > 0,
    remainingUsd: Math.max(0, remaining),
    capUsd: cap,
  };
}
