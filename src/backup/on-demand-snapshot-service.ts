import type { CreditLedger } from "../monetization/credits/credit-ledger.js";
import type { SnapshotManager } from "./snapshot-manager.js";
import type { Snapshot, Tier } from "./types.js";
import { SNAPSHOT_TIER_POLICIES, STORAGE_CHARGE_PER_GB_MONTH, STORAGE_COST_PER_GB_MONTH } from "./types.js";

export interface OnDemandSnapshotServiceConfig {
  manager: SnapshotManager;
  ledger: CreditLedger;
}

export interface CreateSnapshotParams {
  tenant: string;
  instanceId: string;
  userId: string;
  woprHomePath: string;
  name?: string;
  tier: Tier;
  plugins?: string[];
}

export interface CreateSnapshotResult {
  snapshot: Snapshot;
  estimatedMonthlyCostCents: number;
}

export class OnDemandSnapshotService {
  private readonly manager: SnapshotManager;
  private readonly ledger: CreditLedger;

  constructor(cfg: OnDemandSnapshotServiceConfig) {
    this.manager = cfg.manager;
    this.ledger = cfg.ledger;
  }

  /** Check if tenant can create another on-demand snapshot. */
  checkQuota(tenant: string, tier: Tier): { allowed: boolean; current: number; max: number; reason?: string } {
    const policy = SNAPSHOT_TIER_POLICIES[tier];
    const current = this.manager.countByTenant(tenant, "on-demand");
    if (current >= policy.onDemandMax) {
      return {
        allowed: false,
        current,
        max: policy.onDemandMax,
        reason: `On-demand snapshot limit reached: ${current}/${policy.onDemandMax} (${tier} tier)`,
      };
    }
    return { allowed: true, current, max: policy.onDemandMax };
  }

  /** Estimate storage cost for a snapshot of given size. */
  estimateCost(sizeBytes: number): { monthlyCostCents: number; monthlyChargeCents: number } {
    const sizeGb = sizeBytes / (1024 * 1024 * 1024);
    return {
      monthlyCostCents: Math.ceil(sizeGb * STORAGE_COST_PER_GB_MONTH * 100),
      monthlyChargeCents: Math.ceil(sizeGb * STORAGE_CHARGE_PER_GB_MONTH * 100),
    };
  }

  /** Create an on-demand snapshot with all business checks. */
  async create(params: CreateSnapshotParams): Promise<CreateSnapshotResult> {
    // 1. Check credit balance (must have at least 1 cent)
    const balance = this.ledger.balance(params.tenant);
    if (balance <= 0) {
      throw new InsufficientCreditsError(balance);
    }

    // 2. Check quota
    const quota = this.checkQuota(params.tenant, params.tier);
    if (!quota.allowed) {
      throw new SnapshotQuotaExceededError(quota.current, quota.max, params.tier);
    }

    // 3. Compute expiresAt based on tier
    const policy = SNAPSHOT_TIER_POLICIES[params.tier];
    const expiresAt = Date.now() + policy.retentionDays * 24 * 60 * 60 * 1000;

    // 4. Create the snapshot via SnapshotManager
    const snapshot = await this.manager.create({
      tenant: params.tenant,
      instanceId: params.instanceId,
      userId: params.userId,
      woprHomePath: params.woprHomePath,
      trigger: "manual",
      type: "on-demand",
      name: params.name,
      plugins: params.plugins,
      expiresAt,
    });

    // Metering is handled exclusively by the storage-metering cron, which runs
    // periodically and bills for all active on-demand snapshots. Emitting here
    // as well would cause double-billing.
    const sizeBytes = snapshot.sizeBytes ?? Math.round(snapshot.sizeMb * 1024 * 1024);
    const cost = this.estimateCost(sizeBytes);
    return { snapshot, estimatedMonthlyCostCents: cost.monthlyChargeCents };
  }

  /** Delete an on-demand snapshot. Only on-demand snapshots can be deleted by tenants. */
  async delete(snapshotId: string, tenant: string): Promise<boolean> {
    const snapshot = this.manager.get(snapshotId);
    if (!snapshot) return false;
    if (snapshot.tenant !== tenant) return false;
    if (snapshot.type !== "on-demand") {
      throw new Error("Only on-demand snapshots can be deleted by the tenant");
    }
    return this.manager.delete(snapshotId);
  }

  /** List all non-deleted snapshots for a tenant's bot. */
  list(tenant: string, instanceId: string): Snapshot[] {
    return this.manager.list(instanceId).filter((s) => s.tenant === tenant && s.deletedAt === null);
  }
}

export class InsufficientCreditsError extends Error {
  balance: number;
  constructor(balance: number) {
    super(`Insufficient credit balance: ${balance} cents`);
    this.name = "InsufficientCreditsError";
    this.balance = balance;
  }
}

export class SnapshotQuotaExceededError extends Error {
  current: number;
  max: number;
  tier: string;
  constructor(current: number, max: number, tier: string) {
    super(`On-demand snapshot limit reached: ${current}/${max} (${tier} tier)`);
    this.name = "SnapshotQuotaExceededError";
    this.current = current;
    this.max = max;
    this.tier = tier;
  }
}
