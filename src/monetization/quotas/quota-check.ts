import type { PlanTier, SpendOverride } from "./tier-definitions.js";

/** Result of a quota check */
export interface QuotaCheckResult {
  allowed: boolean;
  /** If not allowed, the reason */
  reason?: string;
  /** Current usage */
  currentInstances: number;
  /** Maximum allowed (0 = unlimited) */
  maxInstances: number;
  /** Whether the user is in a soft-cap grace period */
  inGracePeriod: boolean;
}

/** Configuration for soft-cap enforcement */
export interface QuotaEnforcementConfig {
  /** If true, allow one extra instance beyond the limit during grace period */
  softCapEnabled: boolean;
  /** Grace period duration in milliseconds (default: 7 days) */
  gracePeriodMs: number;
}

const DEFAULT_ENFORCEMENT: QuotaEnforcementConfig = {
  softCapEnabled: false,
  gracePeriodMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/**
 * Check whether a user can create a new instance given their tier and current usage.
 *
 * @param tier - The user's plan tier
 * @param activeInstanceCount - Number of currently active (non-removed) instances for this user
 * @param enforcement - Soft-cap configuration
 * @param graceStartedAt - When the grace period started (if applicable), null if not in grace
 */
export function checkInstanceQuota(
  tier: PlanTier,
  activeInstanceCount: number,
  enforcement: QuotaEnforcementConfig = DEFAULT_ENFORCEMENT,
  graceStartedAt: Date | null = null,
): QuotaCheckResult {
  const maxInstances = tier.maxInstances;

  // 0 = unlimited
  if (maxInstances === 0) {
    return {
      allowed: true,
      currentInstances: activeInstanceCount,
      maxInstances,
      inGracePeriod: false,
    };
  }

  // Under the limit — always allowed
  if (activeInstanceCount < maxInstances) {
    return {
      allowed: true,
      currentInstances: activeInstanceCount,
      maxInstances,
      inGracePeriod: false,
    };
  }

  // At or over the limit — check soft cap
  if (enforcement.softCapEnabled && activeInstanceCount === maxInstances) {
    // Allow exactly one over if grace period is active and not expired
    if (graceStartedAt) {
      const elapsed = Date.now() - graceStartedAt.getTime();
      if (elapsed < enforcement.gracePeriodMs) {
        return {
          allowed: true,
          currentInstances: activeInstanceCount,
          maxInstances,
          inGracePeriod: true,
        };
      }
    } else {
      // No grace started yet — this is the first time hitting the cap with soft mode
      return {
        allowed: true,
        currentInstances: activeInstanceCount,
        maxInstances,
        inGracePeriod: true,
      };
    }
  }

  return {
    allowed: false,
    reason: `Instance quota exceeded: ${activeInstanceCount}/${maxInstances} instances in use (${tier.name} tier)`,
    currentInstances: activeInstanceCount,
    maxInstances,
    inGracePeriod: false,
  };
}

/** Result of a spend limit check */
export interface SpendCheckResult {
  allowed: boolean;
  /** If not allowed, the reason */
  reason?: string;
  /** HTTP status to return (402 = Payment Required) */
  httpStatus?: number;
  /** Current hourly spend in USD */
  currentHourlySpend: number;
  /** Current monthly spend in USD */
  currentMonthlySpend: number;
  /** Hourly limit in USD (null = unlimited) */
  maxSpendPerHour: number | null;
  /** Monthly limit in USD (null = unlimited) */
  maxSpendPerMonth: number | null;
  /** Which limit was exceeded: "hourly" | "monthly" | null */
  exceededLimit: "hourly" | "monthly" | null;
}

/**
 * Check whether a tenant has exceeded their spending limits.
 *
 * @param tier - The tenant's plan tier (provides default limits)
 * @param currentHourlySpend - Current spend this hour (from MeterAggregator.getTenantTotal())
 * @param currentMonthlySpend - Current spend this month (from MeterAggregator.getTenantTotal())
 * @param override - Optional per-tenant spend overrides (takes precedence over tier defaults)
 */
export function checkSpendLimit(
  tier: PlanTier,
  currentHourlySpend: number,
  currentMonthlySpend: number,
  override?: SpendOverride | null,
): SpendCheckResult {
  // Per-tenant overrides take precedence over tier defaults
  const maxPerHour = override?.maxSpendPerHour ?? tier.maxSpendPerHour ?? null;
  const maxPerMonth = override?.maxSpendPerMonth ?? tier.maxSpendPerMonth ?? null;

  // Check hourly limit first (more urgent)
  if (maxPerHour !== null && currentHourlySpend >= maxPerHour) {
    return {
      allowed: false,
      reason: `Hourly spending limit exceeded: $${currentHourlySpend.toFixed(2)}/$${maxPerHour.toFixed(2)} (${tier.name} tier). Upgrade your plan for higher limits.`,
      httpStatus: 402,
      currentHourlySpend,
      currentMonthlySpend,
      maxSpendPerHour: maxPerHour,
      maxSpendPerMonth: maxPerMonth,
      exceededLimit: "hourly",
    };
  }

  // Check monthly limit
  if (maxPerMonth !== null && currentMonthlySpend >= maxPerMonth) {
    return {
      allowed: false,
      reason: `Monthly spending limit exceeded: $${currentMonthlySpend.toFixed(2)}/$${maxPerMonth.toFixed(2)} (${tier.name} tier). Upgrade your plan for higher limits.`,
      httpStatus: 402,
      currentHourlySpend,
      currentMonthlySpend,
      maxSpendPerHour: maxPerHour,
      maxSpendPerMonth: maxPerMonth,
      exceededLimit: "monthly",
    };
  }

  return {
    allowed: true,
    currentHourlySpend,
    currentMonthlySpend,
    maxSpendPerHour: maxPerHour,
    maxSpendPerMonth: maxPerMonth,
    exceededLimit: null,
  };
}

/** Summary of a user's current quota usage */
export interface QuotaUsage {
  tier: PlanTier;
  instances: {
    current: number;
    max: number; // 0 = unlimited
    remaining: number; // -1 = unlimited
  };
  resources: {
    memoryLimitMb: number;
    cpuQuota: number;
    storageLimitMb: number;
    maxProcesses: number;
    maxPluginsPerInstance: number | null; // null = unlimited
  };
  spending: {
    maxSpendPerHour: number | null; // null = unlimited
    maxSpendPerMonth: number | null; // null = unlimited
  };
}

/** Build a quota usage summary for the GET /api/quota endpoint */
export function buildQuotaUsage(tier: PlanTier, activeInstanceCount: number): QuotaUsage {
  const max = tier.maxInstances;
  return {
    tier,
    instances: {
      current: activeInstanceCount,
      max,
      remaining: max === 0 ? -1 : Math.max(0, max - activeInstanceCount),
    },
    resources: {
      memoryLimitMb: tier.memoryLimitMb,
      cpuQuota: tier.cpuQuota,
      storageLimitMb: tier.storageLimitMb,
      maxProcesses: tier.maxProcesses,
      maxPluginsPerInstance: tier.maxPluginsPerInstance,
    },
    spending: {
      maxSpendPerHour: tier.maxSpendPerHour ?? null,
      maxSpendPerMonth: tier.maxSpendPerMonth ?? null,
    },
  };
}
