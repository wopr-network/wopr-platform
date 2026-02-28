// =============================================================================
// tRPC Boundary Policy (WOP-805)
// =============================================================================
//
// tRPC owns all typed, session-authenticated procedures consumed by the
// dashboard UI (wopr-platform-ui). Every procedure here MUST be called by
// the UI — dead procedures should be removed.
//
// Current UI consumption (verified against wopr-platform-ui/src/lib/api.ts):
//   billing.*       — credits, checkout, portal, plans, usage, spending limits
//   settings.*      — notification preferences
//   account.*       — deletion lifecycle
//   org.*           — organization settings (stubs, WOP-815)
//   twoFactor.*     — 2FA mandate
//   nodes.*         — hardware node management
//   admin.*         — all admin panel procedures
//   fleet.*         — mirror of REST /fleet/bots/* (UI migration pending)
//
// Routers NOT yet consumed by UI (candidates for cleanup if unused):
//   capabilities.*  — key CRUD + capability settings (listCapabilitySettings, updateCapabilitySettings)
//   credentials.*   — admin credential vault; wire admin UI or remove
//   usage.*         — quota check; UI uses REST /api/quota instead; wire or remove
//
// Adding new procedures:
//   1. The procedure MUST be consumed by the UI or admin dashboard
//   2. It MUST use protectedProcedure or tenantProcedure (no publicProcedure
//      for data queries — use REST for public endpoints)
//   3. Exception: settings.health is public by design (tRPC health check)
//
// =============================================================================

/**
 * Root tRPC app router — composes all domain sub-routers.
 *
 * Usage (from wopr-platform-ui):
 *   import type { AppRouter } from "@wopr-network/wopr-platform/trpc";
 *   const client = createTRPCClient<AppRouter>({ ... });
 */

import { router } from "./init.js";
import { accountRouter } from "./routers/account.js";
import { addonRouter } from "./routers/addons.js";
import { adminRouter } from "./routers/admin.js";
import { billingRouter } from "./routers/billing.js";
import { capabilitiesRouter } from "./routers/capabilities.js";
import { credentialsRouter } from "./routers/credentials.js";
import { fleetRouter } from "./routers/fleet.js";
import { modelSelectionRouter } from "./routers/model-selection.js";
import { nodesRouter } from "./routers/nodes.js";
import { orgRouter } from "./routers/org.js";
import { orgKeysRouter } from "./routers/org-keys.js";
import { pageContextRouter } from "./routers/page-context.js";
import { profileRouter } from "./routers/profile.js";
import { settingsRouter } from "./routers/settings.js";
import { twoFactorRouter } from "./routers/two-factor.js";
import { usageRouter } from "./routers/usage.js";

export const appRouter = router({
  account: accountRouter,
  addons: addonRouter,
  billing: billingRouter,
  capabilities: capabilitiesRouter,
  credentials: credentialsRouter,
  fleet: fleetRouter,
  modelSelection: modelSelectionRouter,
  usage: usageRouter,
  profile: profileRouter,
  settings: settingsRouter,
  admin: adminRouter,
  twoFactor: twoFactorRouter,
  nodes: nodesRouter,
  org: orgRouter,
  orgKeys: orgKeysRouter,
  pageContext: pageContextRouter,
});

/** The root router type — import this in the UI repo for full type inference. */
export type AppRouter = typeof appRouter;

// Re-export context type for adapter usage
export type { TRPCContext } from "./init.js";
export { setTrpcOrgMemberRepo } from "./init.js";
export { setAccountRouterDeps } from "./routers/account.js";
export { setAddonRouterDeps } from "./routers/addons.js";
export { setAdminRouterDeps } from "./routers/admin.js";
// Re-export dep setters for initialization
export { setBillingRouterDeps } from "./routers/billing.js";
export { setCapabilitiesRouterDeps } from "./routers/capabilities.js";
export { setCredentialsRouterDeps } from "./routers/credentials.js";
export { setFleetRouterDeps } from "./routers/fleet.js";
export { setModelSelectionRouterDeps } from "./routers/model-selection.js";
export { setNodesRouterDeps } from "./routers/nodes.js";
export { setOrgRouterDeps } from "./routers/org.js";
export { setOrgKeysRouterDeps } from "./routers/org-keys.js";
export { setProfileRouterDeps } from "./routers/profile.js";
export { setSettingsRouterDeps } from "./routers/settings.js";
export { setTwoFactorRouterDeps } from "./routers/two-factor.js";
