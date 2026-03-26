import { RateStore } from "@wopr-network/platform-core/admin/rates/rate-store";
import { createAdminRateApiRoutes as _create } from "@wopr-network/platform-core/api/routes/admin-rates";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "@wopr-network/platform-core/auth";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { getDb } from "@wopr-network/platform-core/fleet/services";
import { Hono } from "hono";
import { getAdminAuditLog } from "../../fleet/services.js";

/** Backward-compatible factory: takes a DrizzleDb and creates a RateStore internally. */
export function createAdminRateApiRoutes(db: DrizzleDb): Hono<AuthEnv> {
  const store = new RateStore(db);
  return _create(() => store, getAdminAuditLog);
}

let _store: RateStore | null = null;
function getStore(): RateStore {
  if (!_store) {
    _store = new RateStore(getDb());
  }
  return _store;
}

const metadataMap = buildTokenMetadataMap();
const adminAuth = scopedBearerAuthWithTenant(metadataMap, "admin");

/** Pre-built admin rate routes with auth and lazy DB initialization. */
export const adminRateRoutes = new Hono<AuthEnv>();
adminRateRoutes.use("*", adminAuth);
adminRateRoutes.route("/", _create(getStore, getAdminAuditLog));
