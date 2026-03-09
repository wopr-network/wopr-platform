import { logger } from "../config/logger.js";
import type { AdminNotifier } from "./admin-notifier.js";
import type { NodeProvisioner } from "./node-provisioner.js";
import type { INodeRepository } from "./node-repository.js";

export interface CapacityPolicyConfig {
  scaleUpThresholdPercent: number;
  scaleDownThresholdPercent: number;
  scaleDownSustainedMs: number;
  scaleUpCooldownMs: number;
  scaleDownCooldownMs: number;
  minNodes: number;
}

export interface PolicyEvaluation {
  action: "scale_up" | "scale_down" | "none";
  reason: string;
  fleetUsagePercent: number;
  targetNodeId?: string;
}

export const DEFAULT_CAPACITY_POLICY_CONFIG: CapacityPolicyConfig = {
  scaleUpThresholdPercent: 95,
  scaleDownThresholdPercent: 40,
  scaleDownSustainedMs: 300_000,
  scaleUpCooldownMs: 300_000,
  scaleDownCooldownMs: 600_000,
  minNodes: 1,
};

export class CapacityPolicy {
  private lastScaleUpAt = 0;
  private lastScaleDownAt = 0;
  private lowUsageSince: number | null = null;

  constructor(
    private readonly nodeRepo: INodeRepository,
    private readonly provisioner: NodeProvisioner,
    private readonly notifier: AdminNotifier,
    private readonly config: CapacityPolicyConfig = DEFAULT_CAPACITY_POLICY_CONFIG,
  ) {}

  async evaluate(): Promise<PolicyEvaluation> {
    const allNodes = await this.nodeRepo.list();
    const activeNodes = allNodes.filter((n) => n.status === "active" && n.capacityMb > 0);

    if (activeNodes.length === 0) {
      this.lowUsageSince = null;
      return { action: "none", reason: "no active nodes", fleetUsagePercent: 0 };
    }

    const totalCapacity = activeNodes.reduce((sum, n) => sum + n.capacityMb, 0);
    const totalUsed = activeNodes.reduce((sum, n) => sum + n.usedMb, 0);
    const fleetUsagePercent = (totalUsed / totalCapacity) * 100;

    // --- Scale up ---
    if (fleetUsagePercent >= this.config.scaleUpThresholdPercent) {
      this.lowUsageSince = null;
      const now = Date.now();
      if (now - this.lastScaleUpAt < this.config.scaleUpCooldownMs) {
        return { action: "none", reason: "scale-up cooldown active", fleetUsagePercent };
      }
      try {
        await this.provisioner.provision();
        this.lastScaleUpAt = now;
        logger.info(`Auto-scale UP: fleet at ${Math.round(fleetUsagePercent)}%, provisioned new node`);
        await this.notifier.nodeStatusChange("fleet", `auto-scale-up at ${Math.round(fleetUsagePercent)}%`);
        return {
          action: "scale_up",
          reason: `fleet usage ${Math.round(fleetUsagePercent)}% >= ${this.config.scaleUpThresholdPercent}%`,
          fleetUsagePercent,
        };
      } catch (err) {
        logger.error("Auto-scale UP failed", { error: err instanceof Error ? err.message : String(err) });
        return {
          action: "none",
          reason: `scale-up failed: ${err instanceof Error ? err.message : String(err)}`,
          fleetUsagePercent,
        };
      }
    }

    // --- Scale down ---
    if (fleetUsagePercent < this.config.scaleDownThresholdPercent) {
      const now = Date.now();

      if (this.lowUsageSince === null) {
        this.lowUsageSince = now;
      }

      const sustainedDuration = now - this.lowUsageSince;
      if (sustainedDuration < this.config.scaleDownSustainedMs) {
        return {
          action: "none",
          reason: `low usage not yet sustained (${sustainedDuration}ms < ${this.config.scaleDownSustainedMs}ms)`,
          fleetUsagePercent,
        };
      }

      if (now - this.lastScaleDownAt < this.config.scaleDownCooldownMs) {
        return { action: "none", reason: "scale-down cooldown active", fleetUsagePercent };
      }

      if (activeNodes.length <= this.config.minNodes) {
        return { action: "none", reason: `at minNodes (${this.config.minNodes})`, fleetUsagePercent };
      }

      const emptyNodes = activeNodes.filter((n) => n.usedMb === 0);
      if (emptyNodes.length === 0) {
        return { action: "none", reason: "no empty node available for scale-down", fleetUsagePercent };
      }

      const target = emptyNodes[0];
      try {
        await this.provisioner.destroy(target.id);
        this.lastScaleDownAt = now;
        this.lowUsageSince = null;
        logger.info(`Auto-scale DOWN: fleet at ${Math.round(fleetUsagePercent)}%, destroyed node ${target.id}`);
        await this.notifier.nodeStatusChange(target.id, `auto-scale-down at ${Math.round(fleetUsagePercent)}%`);
        return {
          action: "scale_down",
          reason: `fleet usage ${Math.round(fleetUsagePercent)}% < ${this.config.scaleDownThresholdPercent}%`,
          fleetUsagePercent,
          targetNodeId: target.id,
        };
      } catch (err) {
        logger.error(`Auto-scale DOWN failed for node ${target.id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          action: "none",
          reason: `scale-down failed: ${err instanceof Error ? err.message : String(err)}`,
          fleetUsagePercent,
        };
      }
    }

    this.lowUsageSince = null;
    return { action: "none", reason: "fleet usage within normal range", fleetUsagePercent };
  }
}
