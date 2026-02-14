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
 * Instance limits for quota checking.
 * Replaces the old PlanTier dependency — callers pass limits directly.
 */
export interface InstanceLimits {
  maxInstances: number; // 0 = unlimited
  label?: string;
}

/** Default instance limits for credit-based billing (generous defaults). */
export const DEFAULT_INSTANCE_LIMITS: InstanceLimits = {
  maxInstances: 0, // unlimited for paying users
  label: "credit",
};

/**
 * Check whether a user can create a new instance given their limits and current usage.
 *
 * @param limits - Instance limits (max instances, label)
 * @param activeInstanceCount - Number of currently active instances for this user
 * @param enforcement - Soft-cap configuration
 * @param graceStartedAt - When the grace period started (if applicable)
 */
export function checkInstanceQuota(
  limits: InstanceLimits,
  activeInstanceCount: number,
  enforcement: QuotaEnforcementConfig = DEFAULT_ENFORCEMENT,
  graceStartedAt: Date | null = null,
): QuotaCheckResult {
  const maxInstances = limits.maxInstances;

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
    reason: `Instance quota exceeded: ${activeInstanceCount}/${maxInstances} instances in use (${limits.label ?? "current"} plan)`,
    currentInstances: activeInstanceCount,
    maxInstances,
    inGracePeriod: false,
  };
}
