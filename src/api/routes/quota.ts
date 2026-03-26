import { createQuotaRoutes } from "@wopr-network/platform-core/api/routes/quota";
import { buildTokenMap, scopedBearerAuth } from "@wopr-network/platform-core/auth";
import { logger } from "@wopr-network/platform-core/config/logger";
import type { ILedger } from "@wopr-network/platform-core/credits";
import { Hono } from "hono";
import { getCreditLedger } from "../../fleet/services.js";

// Re-export factory from core
export { createQuotaRoutes } from "@wopr-network/platform-core/api/routes/quota";

const quotaTokenMap = buildTokenMap();

let _ledger: ILedger | null = null;

function getLedger(): ILedger {
  if (!_ledger) {
    _ledger = getCreditLedger();
  }
  return _ledger;
}

/** Inject an ILedger for testing */
export function setLedger(l: ILedger): void {
  _ledger = l;
}

/** Pre-built quota routes with auth and lazy ledger. */
export const quotaRoutes = new Hono();

if (quotaTokenMap.size === 0) {
  logger.warn("No API tokens configured — quota routes will reject all requests");
}
quotaRoutes.use("/*", scopedBearerAuth(quotaTokenMap, "admin"));
quotaRoutes.route("/", createQuotaRoutes(getLedger));
