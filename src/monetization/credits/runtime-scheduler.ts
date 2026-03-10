import type { ICreditLedger } from "@wopr-network/platform-core/credits";
import { logger } from "../../config/logger.js";
import type { IBotInstanceRepository } from "../../fleet/bot-instance-repository.js";
import { buildAddonCosts } from "../addons/addon-cron.js";
import type { ITenantAddonRepository } from "../addons/addon-repository.js";
import { buildResourceTierCosts, runRuntimeDeductions } from "./runtime-cron.js";

export interface RuntimeSchedulerDeps {
  ledger: ICreditLedger;
  botInstanceRepo: IBotInstanceRepository;
  tenantAddonRepo: ITenantAddonRepository;
  onSuspend?: (tenantId: string) => void;
}

export interface RuntimeSchedulerHandle {
  stop: () => void;
}

/** 24 hours in milliseconds — matches the date-only referenceId granularity. */
export const RUNTIME_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * Start the runtime deduction scheduler.
 *
 * Calls `runRuntimeDeductions` once per day. The referenceId is
 * `runtime:${date}:${tenantId}` (date-only), so running more frequently
 * than once per day produces only wasted DB round-trips with no billing effect.
 *
 * Returns a handle whose `stop()` cancels the interval.
 */
export function startRuntimeScheduler(deps: RuntimeSchedulerDeps): RuntimeSchedulerHandle {
  const { ledger, botInstanceRepo, tenantAddonRepo, onSuspend } = deps;

  const getResourceTierCosts = buildResourceTierCosts(botInstanceRepo, async (tenantId) => {
    const bots = await botInstanceRepo.listByTenant(tenantId);
    return bots.filter((b) => b.billingState === "active").map((b) => b.id);
  });

  const getAddonCosts = buildAddonCosts(tenantAddonRepo);

  const handle = setInterval(() => {
    const today = new Date().toISOString().slice(0, 10);
    void runRuntimeDeductions({
      ledger,
      date: today,
      getActiveBotCount: async (tenantId) => {
        const bots = await botInstanceRepo.listByTenant(tenantId);
        return bots.filter((b) => b.billingState === "active").length;
      },
      getResourceTierCosts,
      getAddonCosts,
      onSuspend,
    })
      .then((result) => {
        logger.info("Runtime deductions complete", result);
      })
      .catch((err) => {
        logger.error("Runtime deductions failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, RUNTIME_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(handle);
      logger.info("Runtime deduction scheduler stopped");
    },
  };
}
