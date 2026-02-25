import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AuthUser } from "../auth/index.js";
import { buildTokenMetadataMap, extractBearerToken, resolveSessionUser } from "../auth/index.js";
import { logger } from "../config/logger.js";
import { checkAllCerts } from "../monitoring/cert-expiry.js";
import { appRouter } from "../trpc/index.js";
import type { TRPCContext } from "../trpc/init.js";
import { platformDefaultLimit, platformRateLimitRules, rateLimitByRoute } from "./middleware/rate-limit.js";
import { activityRoutes } from "./routes/activity.js";
import { adminBackupRoutes } from "./routes/admin-backups.js";
import { adminCreditRoutes } from "./routes/admin-credits.js";
import { adminGpuRoutes } from "./routes/admin-gpu.js";
import { adminMigrationRoutes } from "./routes/admin-migration.js";
import { adminNotesRoutes } from "./routes/admin-notes.js";
import { adminRateRoutes } from "./routes/admin-rates.js";
import { adminNodeRoutes, adminRecoveryRoutes } from "./routes/admin-recovery.js";
import { adminUsersApiRoutes } from "./routes/admin-users.js";
import { adminAuditRoutes, auditRoutes } from "./routes/audit.js";
import { billingRoutes } from "./routes/billing.js";
import { botPluginRoutes } from "./routes/bot-plugins.js";
import { botSnapshotRoutes } from "./routes/bot-snapshots.js";
import { channelOAuthRoutes } from "./routes/channel-oauth.js";
import { channelValidateRoutes } from "./routes/channel-validate.js";
import { fleetRoutes } from "./routes/fleet.js";
import { fleetResourceRoutes } from "./routes/fleet-resources.js";
import { friendsRoutes } from "./routes/friends.js";
import { healthRoutes } from "./routes/health.js";
import { internalGpuRoutes } from "./routes/internal-gpu.js";
import { internalNodeRoutes } from "./routes/internal-nodes.js";
import { marketplaceRoutes } from "./routes/marketplace.js";
import { publicPricingRoutes } from "./routes/public-pricing.js";
import { quotaRoutes } from "./routes/quota.js";
import { secretsRoutes } from "./routes/secrets.js";
import { snapshotRoutes } from "./routes/snapshots.js";
import { tenantKeyRoutes } from "./routes/tenant-keys.js";
import { tenantProxyMiddleware } from "./routes/tenant-proxy.js";
import { verifyEmailRoutes } from "./routes/verify-email.js";

// =============================================================================
// REST vs tRPC Boundary Policy (WOP-805)
// =============================================================================
//
// This file mounts BOTH REST (Hono) routes and the tRPC handler. The boundary
// between them is determined by WHO calls the endpoint and WHAT transport
// constraints apply.
//
// REST is the correct layer for:
//   - Webhooks from external services (Stripe, PayRam, Twilio) — raw HTTP sigs
//   - Public unauthenticated endpoints (health, pricing, email verification)
//   - OAuth redirect flows (channel-oauth initiate/callback)
//   - Internal machine-to-machine APIs (node agent registration, static bearer)
//   - Service-key gateway (/v1/* bot-facing API)
//   - better-auth handler (/api/auth/*)
//   - Tenant subdomain proxy (*.wopr.bot)
//   - Binary/streaming responses (container logs as text/plain)
//
// tRPC is the correct layer for:
//   - All dashboard UI calls (wopr-platform-ui uses trpcFetch/trpcMutate)
//   - All admin panel calls (admin dashboard)
//   - Any typed mutation with Zod validation consumed by the UI
//   - Session-cookie-authenticated browser requests
//
// Migration candidates (REST routes that SHOULD move to tRPC):
//   - /api/activity → tRPC activity.feed (session-authed, UI calls it)
//   - /api/fleet/resources → tRPC fleet.resources (session-authed, UI calls it)
//   - /api/marketplace/* → tRPC marketplace.* (session-authed, UI calls it)
//   - /fleet/bots/* → already has tRPC mirror (fleet router); UI needs to switch
//   - /api/audit → tRPC audit.query (session-authed; admin version in tRPC admin)
//   - /api/quota → tRPC usage router already exists; REST is legacy
//   - /api/tenant-keys → tRPC capabilities router already covers this
//
// REST routes that must STAY as REST (see blockers):
//   - /api/billing/webhook — Stripe signature verification (cannot be tRPC)
//   - /api/billing/crypto/* — PayRam webhook + checkout (external service)
//   - /api/billing/setup-intent — returns clientSecret for Stripe.js (REST is simpler)
//   - /api/billing/payment-methods/:id DELETE — Stripe detach (REST for now, low priority)
//   - /api/billing/credits/checkout — has tRPC mirror, keep REST until UI fully migrates
//   - /api/billing/portal — has tRPC mirror, keep REST until UI fully migrates
//   - /api/channel-oauth/* — OAuth redirect flow (HTTP redirects, not JSON RPC)
//   - /api/secrets/* — bearer-token-scoped, consumed by fleet manager (not UI)
//   - /api/instances/:id/friends — proxy to instance (not a platform concern)
//   - /api/instances/:id/snapshots — bearer-token-scoped
//   - /api/bots/:id/snapshots — bearer-token-scoped
//   - /api/admin/* REST — all have tRPC mirrors, keep REST until admin UI migrates
//   - /fleet/bots/* REST — has tRPC mirror, keep REST for CLI/SDK consumers
//   - /internal/nodes/* — machine-to-machine, static bearer
//   - /health — public, no auth
//   - /api/v1/pricing — public, no auth
//   - /auth/verify — public link click, redirects to UI
//   - /v1/* gateway — service key auth, bot-facing
//
// =============================================================================

export const app = new Hono();

// Tenant subdomain proxy — catch-all for *.wopr.bot requests.
// Mounted BEFORE global middleware so that CORS, secureHeaders, and
// rate-limiting do not interfere with proxied tenant traffic. The
// upstream containers apply their own middleware independently.
// Uses app.use() so that requests without a tenant subdomain (no host
// header, reserved subdomains, localhost) fall through to subsequent routes.
app.use("/*", tenantProxyMiddleware);

app.use(
  "/*",
  cors({
    origin: (process.env.UI_ORIGIN || "http://localhost:3001").split(",").map((s) => s.trim()),
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use("/*", secureHeaders());
// Rate limiting via DB-backed repo. Lazily initialized on first request to
// avoid opening platform.db at module load time (tests import app.ts too).
let _rateLimitMiddleware: MiddlewareHandler | null = null;
app.use("*", async (c, next) => {
  if (!_rateLimitMiddleware) {
    try {
      const { getRateLimitRepo } = await import("../fleet/services.js");
      _rateLimitMiddleware = rateLimitByRoute(platformRateLimitRules, platformDefaultLimit, getRateLimitRepo());
    } catch {
      // DB unavailable (e.g., test environment) — skip rate limiting for this request
      return next();
    }
  }
  return _rateLimitMiddleware(c, next);
});

// SOC 2 M1: Password complexity enforcement middleware for sign-up and password change.
// Validates before forwarding to better-auth so bad passwords are rejected early
// with a clear error message. Better-auth also enforces minPasswordLength: 12.
app.post("/api/auth/sign-up/email", async (c, next) => {
  try {
    const cloned = c.req.raw.clone();
    const body = await cloned.json();
    const password: unknown = body?.password;
    if (typeof password === "string" && password.length >= 12) {
      const hasUpper = /[A-Z]/.test(password);
      const hasLower = /[a-z]/.test(password);
      const hasDigit = /[0-9]/.test(password);
      const hasSpecial = /[^A-Za-z0-9]/.test(password);
      if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) {
        return c.json(
          {
            error: "Password must contain uppercase, lowercase, a number, and a special character",
          },
          400,
        );
      }
    }
  } catch {
    // If we can't parse the body, let better-auth handle it
  }
  return next();
});

// SOC 2 M1: Apply the same password complexity check to the reset-password flow.
app.post("/api/auth/reset-password", async (c, next) => {
  try {
    const cloned = c.req.raw.clone();
    const body = await cloned.json();
    const password: unknown = body?.password;
    if (typeof password === "string" && password.length >= 12) {
      const hasUpper = /[A-Z]/.test(password);
      const hasLower = /[a-z]/.test(password);
      const hasDigit = /[0-9]/.test(password);
      const hasSpecial = /[^A-Za-z0-9]/.test(password);
      if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) {
        return c.json(
          {
            error: "Password must contain uppercase, lowercase, a number, and a special character",
          },
          400,
        );
      }
    }
  } catch {
    // If we can't parse the body, let better-auth handle it
  }
  return next();
});

// better-auth handler — serves /api/auth/* (signup, login, session, etc.)
// Lazily initialized to avoid opening DB at import time.
//
// For POST requests we buffer the raw body bytes and reconstruct a fresh
// Request. This is necessary because the password-complexity middleware above
// calls c.req.raw.clone() which tees the IncomingMessage stream — leaving
// c.req.raw.body in a "first-tee-side-drained" state. A subsequent .clone()
// on an already-teed stream produces a locked / partially-consumed body in
// Node 25's undici, causing JSON parse errors for any character ≥ U+0021 that
// appears near the tee boundary (WOP-988). Buffering the bytes via
// c.req.arrayBuffer() reads the unconsumed tee half into memory, then we
// hand better-auth a brand-new Request with that buffer as its body.
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  const { getAuth } = await import("../auth/better-auth.js");
  let req: Request;
  if (c.req.method === "POST") {
    const body = await c.req.arrayBuffer();
    req = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body,
    });
  } else {
    req = c.req.raw;
  }
  return getAuth().handler(req);
});

// Resolve session user from better-auth cookie on all API and fleet routes.
// This sets c.set("user") if a valid session cookie is present.
// Routes that also accept API tokens (scopedBearerAuth) will override if needed.
app.use("/api/*", resolveSessionUser());
app.use("/fleet/*", resolveSessionUser());

app.route("/health", healthRoutes);

// GET /health/certs — certificate expiry status
app.get("/health/certs", async (c) => {
  const domains = process.env.CERT_CHECK_DOMAINS?.split(",").map((s) => s.trim()) || undefined;
  const results = await checkAllCerts(domains);
  const expiringSoon = results.filter((r) => r.daysRemaining !== undefined && r.daysRemaining < 30);
  const failed = results.filter((r) => !r.valid);
  const status = failed.length > 0 || expiringSoon.length > 0 ? 503 : 200;
  return c.json({ ok: status === 200, results, expiringSoon: expiringSoon.length, failed: failed.length }, status);
});
app.route("/fleet", fleetRoutes);
app.route("/fleet", botPluginRoutes);
app.route("/api/quota", quotaRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api", secretsRoutes);
app.route("/api/instances/:id/snapshots", snapshotRoutes);
app.route("/api/bots/:id/snapshots", botSnapshotRoutes);
app.route("/api/instances/:id/friends", friendsRoutes);
app.route("/api/audit", auditRoutes);
app.route("/api/admin/audit", adminAuditRoutes);
app.route("/api/admin/backups", adminBackupRoutes);
app.route("/api/admin/credits", adminCreditRoutes);
app.route("/api/admin/notes", adminNotesRoutes);
app.route("/api/admin/rates", adminRateRoutes);
app.route("/api/admin/recovery", adminRecoveryRoutes);
app.route("/api/admin/nodes", adminNodeRoutes);
app.route("/api/admin/gpu", adminGpuRoutes);
app.route("/api/admin/migrate", adminMigrationRoutes);
app.route("/api/admin/users", adminUsersApiRoutes);
app.route("/api/channel-oauth", channelOAuthRoutes);
app.route("/api/channels", channelValidateRoutes);
app.route("/api/tenant-keys", tenantKeyRoutes);
app.route("/api/v1/pricing", publicPricingRoutes);
app.route("/api/activity", activityRoutes);
app.route("/api/fleet/resources", fleetResourceRoutes);
app.route("/api/marketplace", marketplaceRoutes);
app.route("/auth", verifyEmailRoutes);
app.route("/internal/nodes", internalNodeRoutes);
app.route("/internal/gpu", internalGpuRoutes);

// Gateway routes — /v1/* endpoints for bot-facing API.
// These use service key auth (not session cookies), so they are mounted
// separately and do NOT go through resolveSessionUser.
// Lazily initialized: createGatewayRoutes requires runtime dependencies
// (MeterEmitter, BudgetChecker) that may not be available at import time.
// Wire up via mountGateway() from src/gateway/index.ts when deps are ready.
// See: src/gateway/routes.ts for endpoint definitions.

// ---------------------------------------------------------------------------
// tRPC — mounted at /trpc/* alongside existing routes
// ---------------------------------------------------------------------------

const trpcTokenMetadataMap = buildTokenMetadataMap();

/**
 * Create tRPC context from an incoming request.
 * Resolves the user from bearer tokens or better-auth session cookies.
 */
async function createTRPCContext(req: Request): Promise<TRPCContext> {
  let user: AuthUser | undefined;
  let tenantId: string | undefined;

  // 1. Try bearer token
  const authHeader = req.headers.get("Authorization") ?? undefined;
  const token = extractBearerToken(authHeader);

  if (token) {
    const metadata = trpcTokenMetadataMap.get(token);
    if (metadata) {
      user = { id: `token:${metadata.scope}`, roles: [metadata.scope] };
      tenantId = metadata.tenantId;
    }
  }

  // 2. Fall back to better-auth session cookie
  if (!user) {
    try {
      const { getAuth } = await import("../auth/better-auth.js");
      const auth = getAuth();
      const session = await auth.api.getSession({ headers: req.headers });
      if (session?.user) {
        const sessionUser = session.user as { id: string; role?: string };
        const roles: string[] = [];
        if (sessionUser.role) roles.push(sessionUser.role);
        user = { id: sessionUser.id, roles };
        // For session-cookie users, userId === tenantId (single-user tenant model).
        // This allows tenantProcedure to work without a bearer token.
        tenantId = sessionUser.id;
      }
    } catch {
      // Session resolution failed — user stays undefined
    }
  }

  return { user, tenantId };
}

app.all("/trpc/*", async (c) => {
  const response = await fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: () => createTRPCContext(c.req.raw),
  });
  return response;
});

// Global error handler — catches all errors from routes and middleware.
// This prevents unhandled errors from crashing the process.
export const errorHandler: Parameters<typeof app.onError>[0] = (err, c) => {
  logger.error("Unhandled error in request", {
    error: err.message,
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
  });

  // Return a safe error response to the client
  return c.json(
    {
      error: "Internal server error",
      message: "An unexpected error occurred while processing your request",
    },
    500,
  );
};

app.onError(errorHandler);
