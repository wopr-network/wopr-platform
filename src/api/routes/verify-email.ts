import { createVerifyEmailRoutesLazy } from "@wopr-network/platform-core/api/routes/verify-email";
import { getPool } from "@wopr-network/platform-core/fleet/services";
import { getCreditLedger } from "../../platform-services.js";

export type { VerifyEmailRouteConfig, VerifyEmailRouteDeps } from "@wopr-network/platform-core/api/routes/verify-email";
// Re-export factories from core — other brands use these directly
export {
  createVerifyEmailRoutes,
  createVerifyEmailRoutesLazy,
} from "@wopr-network/platform-core/api/routes/verify-email";

/** Production routes using lazy-initialized dependencies. */
export const verifyEmailRoutes = createVerifyEmailRoutesLazy(getPool, getCreditLedger);
