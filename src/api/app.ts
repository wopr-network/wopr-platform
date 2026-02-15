import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AuthUser } from "../auth/index.js";
import { buildTokenMetadataMap, extractBearerToken, resolveSessionUser } from "../auth/index.js";
import { logger } from "../config/logger.js";
import { appRouter } from "../trpc/index.js";
import type { TRPCContext } from "../trpc/init.js";
import { platformDefaultLimit, platformRateLimitRules, rateLimitByRoute } from "./middleware/rate-limit.js";
import { adminBackupRoutes } from "./routes/admin-backups.js";
import { adminCreditRoutes } from "./routes/admin-credits.js";
import { adminNodeRoutes, adminRecoveryRoutes } from "./routes/admin-recovery.js";
import { adminAuditRoutes, auditRoutes } from "./routes/audit.js";
import { billingRoutes } from "./routes/billing.js";
import { fleetRoutes } from "./routes/fleet.js";
import { friendsRoutes } from "./routes/friends.js";
import { healthRoutes } from "./routes/health.js";
import { internalNodeRoutes } from "./routes/internal-nodes.js";
import { quotaRoutes } from "./routes/quota.js";
import { secretsRoutes } from "./routes/secrets.js";
import { snapshotRoutes } from "./routes/snapshots.js";
import { tenantKeyRoutes } from "./routes/tenant-keys.js";
import { verifyEmailRoutes } from "./routes/verify-email.js";

export const app = new Hono();

app.use(
  "/*",
  cors({
    origin: process.env.UI_ORIGIN || "http://localhost:3001",
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use("/*", secureHeaders());
app.use("*", rateLimitByRoute(platformRateLimitRules, platformDefaultLimit));

// better-auth handler — serves /api/auth/* (signup, login, session, etc.)
// Lazily initialized to avoid opening DB at import time.
app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  const { getAuth } = await import("../auth/better-auth.js");
  return getAuth().handler(c.req.raw);
});

// Resolve session user from better-auth cookie on all API and fleet routes.
// This sets c.set("user") if a valid session cookie is present.
// Routes that also accept API tokens (scopedBearerAuth) will override if needed.
app.use("/api/*", resolveSessionUser());
app.use("/fleet/*", resolveSessionUser());

app.route("/health", healthRoutes);
app.route("/fleet", fleetRoutes);
app.route("/api/quota", quotaRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api", secretsRoutes);
app.route("/api/instances/:id/snapshots", snapshotRoutes);
app.route("/api/instances/:id/friends", friendsRoutes);
app.route("/api/audit", auditRoutes);
app.route("/api/admin/audit", adminAuditRoutes);
app.route("/api/admin/backups", adminBackupRoutes);
app.route("/api/admin/credits", adminCreditRoutes);
app.route("/api/admin/recovery", adminRecoveryRoutes);
app.route("/api/admin/nodes", adminNodeRoutes);
app.route("/api/tenant-keys", tenantKeyRoutes);
app.route("/auth", verifyEmailRoutes);
app.route("/internal/nodes", internalNodeRoutes);

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
