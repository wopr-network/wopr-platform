import { createQuotaRoutes } from "@wopr-network/platform-core/api/routes/quota";
import { buildTokenMap, scopedBearerAuth } from "@wopr-network/platform-core/auth";
import { logger } from "@wopr-network/platform-core/config/logger";
import type { ICreditLedger } from "@wopr-network/platform-core/credits";
import { Hono } from "hono";
import { getCreditLedger } from "../../platform-services.js";

// Re-export factory from core
export { createQuotaRoutes } from "@wopr-network/platform-core/api/routes/quota";

const quotaTokenMap = buildTokenMap();

let _ledger: ICreditLedger | null = null;

function getLedger(): ICreditLedger {
  if (!_ledger) {
    _ledger = getCreditLedger();
  }
  return _ledger;
}

/** Inject a CreditLedger for testing */
export function setLedger(l: ICreditLedger): void {
  _ledger = l;
}

/** Pre-built quota routes with auth and lazy ledger. */
export const quotaRoutes = new Hono();

if (quotaTokenMap.size === 0) {
  logger.warn("No API tokens configured — quota routes will reject all requests");
}
quotaRoutes.use("/*", scopedBearerAuth(quotaTokenMap, "admin"));
quotaRoutes.route("/", createQuotaRoutes(getLedger));
