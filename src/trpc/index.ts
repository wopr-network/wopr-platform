/**
 * Root tRPC app router — composes all domain sub-routers.
 *
 * Usage (from wopr-platform-ui):
 *   import type { AppRouter } from "@wopr-network/wopr-platform/trpc";
 *   const client = createTRPCClient<AppRouter>({ ... });
 */

import { router } from "./init.js";
import { adminRouter } from "./routers/admin.js";
import { billingRouter } from "./routers/billing.js";
import { capabilitiesRouter } from "./routers/capabilities.js";
import { settingsRouter } from "./routers/settings.js";
import { usageRouter } from "./routers/usage.js";

export const appRouter = router({
  billing: billingRouter,
  capabilities: capabilitiesRouter,
  usage: usageRouter,
  settings: settingsRouter,
  admin: adminRouter,
});

/** The root router type — import this in the UI repo for full type inference. */
export type AppRouter = typeof appRouter;

// Re-export context type for adapter usage
export type { TRPCContext } from "./init.js";
export { setAdminRouterDeps } from "./routers/admin.js";
// Re-export dep setters for initialization
export { setBillingRouterDeps } from "./routers/billing.js";
export { setCapabilitiesRouterDeps } from "./routers/capabilities.js";
