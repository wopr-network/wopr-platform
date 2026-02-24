import { createHmac } from "node:crypto";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { eq, gte, sql } from "drizzle-orm";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { RateStore } from "./admin/rates/rate-store.js";
import { initRateSchema } from "./admin/rates/schema.js";
import { app } from "./api/app.js";
import { DrizzleOAuthStateRepository } from "./api/drizzle-oauth-state-repository.js";
import { DrizzleSigPenaltyRepository } from "./api/drizzle-sig-penalty-repository.js";
import { setBillingDeps } from "./api/routes/billing.js";
import { setBotPluginDeps } from "./api/routes/bot-plugins.js";
import { setChannelOAuthRepo } from "./api/routes/channel-oauth.js";
import { validateNodeAuth } from "./api/routes/internal-nodes.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "./auth/index.js";
import { config } from "./config/index.js";
import { logger } from "./config/logger.js";
import { applyPlatformPragmas, createDb } from "./db/index.js";
import * as schema from "./db/schema/index.js";
import type { CommandResult } from "./fleet/node-command-bus.js";
import {
  getAffiliateRepo,
  getBackupVerifier,
  getBotInstanceRepo,
  getBotProfileRepo,
  getCircuitBreakerRepo,
  getCommandBus,
  getConnectionRegistry,
  getCreditLedger,
  getDb,
  getDividendRepo,
  getFleetEventRepo,
  getHeartbeatProcessor,
  getHeartbeatWatchdog,
  getNodeRegistrar,
  getNodeRepo,
  getNotificationPrefsStore,
  getRateLimitRepo,
  getRegistrationTokenStore,
  getSystemResourceMonitor,
  initFleet,
} from "./fleet/services.js";
import { DrizzleSpendingCapStore } from "./fleet/spending-cap-repository.js";
import { mountGateway } from "./gateway/index.js";
import { createCachedRateLookup } from "./gateway/rate-lookup.js";
import type { GatewayTenant } from "./gateway/types.js";
import { BudgetChecker } from "./monetization/budget/budget-checker.js";
import { CreditLedger } from "./monetization/credits/credit-ledger.js";
import { buildResourceTierCosts, runRuntimeDeductions } from "./monetization/credits/runtime-cron.js";
import { MeterEmitter } from "./monetization/metering/emitter.js";
import type { HeartbeatMessage } from "./node-agent/types.js";
import { DrizzleMetricsRepository } from "./observability/drizzle-metrics-repository.js";
import {
  AlertChecker,
  buildAlerts,
  buildCriticalAlerts,
  captureError,
  createAdminHealthHandler,
  initSentry,
  MetricsCollector,
  PagerDutyNotifier,
} from "./observability/index.js";
import { hydrateProxyRoutes } from "./proxy/singleton.js";
import { DrizzleCredentialRepository } from "./security/credential-vault/credential-repository.js";
import { CredentialVaultStore, getVaultEncryptionKey } from "./security/credential-vault/store.js";
import { encrypt } from "./security/encryption.js";
import { validateProviderKey } from "./security/key-validation.js";
import { CapabilitySettingsStore } from "./security/tenant-keys/capability-settings-store.js";
import { TenantKeyStore } from "./security/tenant-keys/schema.js";
import type { Provider } from "./security/types.js";
import {
  setBillingRouterDeps,
  setCapabilitiesRouterDeps,
  setModelSelectionRouterDeps,
  setNodesRouterDeps,
  setProfileRouterDeps,
  setSettingsRouterDeps,
} from "./trpc/index.js";

const BILLING_DB_PATH = process.env.BILLING_DB_PATH || "/data/platform/billing.db";
const RATES_DB_PATH = process.env.RATES_DB_PATH || "/data/platform/rates.db";
const TENANT_KEYS_DB_PATH = process.env.TENANT_KEYS_DB_PATH || "/data/platform/tenant-keys.db";

/**
 * Validate critical environment variables at startup.
 * Fails fast if required vars are missing or weak.
 * Skip validation in test mode.
 */
function validateRequiredEnvVars() {
  if (process.env.NODE_ENV === "test") return;

  const issues: string[] = [];

  const platformSecret = process.env.PLATFORM_SECRET;
  if (!platformSecret) {
    issues.push("PLATFORM_SECRET is required but not set");
  } else if (platformSecret.length < 32) {
    issues.push("PLATFORM_SECRET must be at least 32 characters");
  }

  if (issues.length > 0) {
    throw new Error(`Environment validation failed:\n${issues.join("\n")}`);
  }
}

validateRequiredEnvVars();

const port = config.port;

// Global process-level error handlers to prevent crashes from unhandled errors.
// These handlers ensure the process logs critical errors and handles them gracefully.

// Handle unhandled promise rejections (async errors that weren't caught)
export const unhandledRejectionHandler = (reason: unknown, promise: Promise<unknown>) => {
  logger.error("Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: String(promise),
  });
  captureError(reason instanceof Error ? reason : new Error(String(reason)), {
    source: "unhandledRejection",
  });
  // Don't exit — log and continue serving other tenants
};

// Handle uncaught exceptions (synchronous errors that weren't caught)
export const uncaughtExceptionHandler = (err: Error, origin: string) => {
  logger.error("Uncaught exception", {
    error: err.message,
    stack: err.stack,
    origin,
  });
  captureError(err, { source: "uncaughtException", origin });
  // Uncaught exceptions leave the process in an undefined state.
  // Exit immediately after logging (Winston Console transport is synchronous).
  process.exit(1);
};

process.on("unhandledRejection", unhandledRejectionHandler);
process.on("uncaughtException", uncaughtExceptionHandler);

// Initialize Sentry error tracking (no-op when SENTRY_DSN absent)
initSentry(process.env.SENTRY_DSN);

function isHeartbeatMessage(msg: unknown): msg is HeartbeatMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).type === "heartbeat" &&
    typeof (msg as Record<string, unknown>).node_id === "string"
  );
}

function isCommandResult(msg: unknown): msg is CommandResult {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    m.type === "command_result" &&
    typeof m.command === "string" &&
    typeof m.success === "boolean"
  );
}

/**
 * Accept a WebSocket connection for a node agent and wire up message routing
 * to the new fleet processors (ConnectionRegistry, HeartbeatProcessor, CommandBus, NodeRegistrar).
 */
function acceptAndWireWebSocket(nodeId: string, ws: WebSocket): void {
  getConnectionRegistry().accept(nodeId, ws);

  ws.on("message", (data: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      logger.warn(`Received non-JSON message from ${nodeId}`);
      return;
    }

    const msg = parsed as Record<string, unknown>;

    if (msg.type === "heartbeat") {
      if (!isHeartbeatMessage(msg)) {
        logger.warn(`Malformed heartbeat message from ${nodeId}`);
        return;
      }
      getHeartbeatProcessor().process(nodeId, msg);
    } else if (msg.type === "command_result") {
      if (!isCommandResult(msg)) {
        logger.warn(`Malformed command_result message from ${nodeId}`);
        return;
      }
      getCommandBus().handleResult(msg);
    } else if (msg.type === "register") {
      getNodeRegistrar().register({
        nodeId,
        host: (msg.host as string) ?? "",
        capacityMb: (msg.capacity_mb as number) ?? 0,
        agentVersion: (msg.agent_version as string) ?? "",
      });
    } else if (msg.type === "health_event") {
      logger.warn(`Health event from ${nodeId}`, { event: msg });
    } else {
      logger.debug(`Unknown message type from ${nodeId}`, { msg });
    }
  });

  ws.on("close", () => {
    logger.info(`Node ${nodeId} disconnected`);
    getConnectionRegistry().close(nodeId);
  });

  ws.on("error", (err: Error) => {
    logger.warn(`WebSocket error from node ${nodeId}`, { err });
    getConnectionRegistry().close(nodeId);
  });
}

// Only start the server if not imported by tests
if (process.env.NODE_ENV !== "test") {
  logger.info(`wopr-platform starting on port ${port}`);

  // ── Gateway wiring ──────────────────────────────────────────────────────────
  // Mount /v1/* gateway routes. Must be done before serve() so routes are
  // registered. Provider API keys are optional — omitting one disables that
  // capability silently (gateway returns 503 for unconfigured providers).
  {
    const billingDb = new Database(BILLING_DB_PATH);
    applyPlatformPragmas(billingDb);
    const billingDrizzle = createDb(billingDb);

    // ── Observability ──────────────────────────────────────────────────────────
    const metricsRepo = new DrizzleMetricsRepository(billingDrizzle);
    const metrics = new MetricsCollector(metricsRepo);
    const fleetEventRepo = getFleetEventRepo();
    const alerts = buildAlerts(metrics, fleetEventRepo);

    // ── PagerDuty integration ────────────────────────────────────────────────
    const pagerduty = new PagerDutyNotifier(config.pagerduty);

    const criticalAlerts = buildCriticalAlerts({
      metrics,
      dbHealthCheck: () => {
        try {
          billingDrizzle.run(sql`SELECT 1`);
          return true;
        } catch {
          return false;
        }
      },
      authHealthCheck: () => {
        // Auth is co-located — if platform is running, auth is up.
        return true;
      },
      gatewayHealthCheck: () => {
        const window = metrics.getWindow(1);
        const last5m = metrics.getWindow(5);
        const healthy = window.totalRequests > 0 || last5m.totalRequests === 0;
        return { healthy, latencyMs: 0 };
      },
    });

    const allAlerts = [...alerts, ...criticalAlerts];
    const alertChecker = new AlertChecker(allAlerts, {
      fleetEventRepo,
      onFire: (alertName, result) => {
        const severity = alertName.startsWith("sev1-") ? "critical" : "error";
        void pagerduty.trigger(alertName, result.message, severity, {
          value: result.value,
          threshold: result.threshold,
        });
      },
      onResolve: (alertName) => {
        void pagerduty.resolve(alertName);
      },
    });
    alertChecker.start();

    const ratesDb = new Database(RATES_DB_PATH);
    applyPlatformPragmas(ratesDb);
    initRateSchema(ratesDb);
    const rateStore = new RateStore(ratesDb);

    const meter = new MeterEmitter(billingDrizzle);
    const budgetChecker = new BudgetChecker(billingDrizzle);
    const creditLedger = new CreditLedger(billingDrizzle);

    // Build resolveServiceKey from FLEET_TOKEN_<TENANT>=<scope>:<token> env vars.
    // The same tokens that authenticate the fleet API also authenticate gateway calls.
    const tokenMetadata = buildTokenMetadataMap();
    const resolveServiceKey = (key: string): GatewayTenant | null => {
      const meta = tokenMetadata.get(key);
      if (!meta?.tenantId) return null;
      return {
        id: meta.tenantId,
        // Unlimited spend limits at key resolution — BudgetChecker enforces per-tenant
        // limits against actual meter_events at call time.
        spendLimits: { maxSpendPerHour: null, maxSpendPerMonth: null },
      };
    };

    // Wire hosted credential injection for plugin install route
    const vaultKey = getVaultEncryptionKey(process.env.PLATFORM_SECRET);
    const credentialRepo = new DrizzleCredentialRepository(billingDrizzle);
    const credentialVault = new CredentialVaultStore(credentialRepo, vaultKey);
    setBotPluginDeps({ credentialVault, meterEmitter: meter });

    mountGateway(app, {
      meter,
      budgetChecker,
      creditLedger,
      spendingCapStore: new DrizzleSpendingCapStore(billingDrizzle),
      metrics,
      providers: {
        openrouter: process.env.OPENROUTER_API_KEY ? { apiKey: process.env.OPENROUTER_API_KEY } : undefined,
        deepgram: process.env.DEEPGRAM_API_KEY ? { apiKey: process.env.DEEPGRAM_API_KEY } : undefined,
        elevenlabs: process.env.ELEVENLABS_API_KEY ? { apiKey: process.env.ELEVENLABS_API_KEY } : undefined,
        replicate: process.env.REPLICATE_API_TOKEN ? { apiToken: process.env.REPLICATE_API_TOKEN } : undefined,
        twilio:
          process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
            ? {
                accountSid: process.env.TWILIO_ACCOUNT_SID,
                authToken: process.env.TWILIO_AUTH_TOKEN,
              }
            : undefined,
        telnyx: process.env.TELNYX_API_KEY ? { apiKey: process.env.TELNYX_API_KEY } : undefined,
      },
      rateLookupFn: createCachedRateLookup(rateStore.getSellRateByModel.bind(rateStore)),
      resolveServiceKey,
      capabilityRateLimitConfig: {
        llm: Number(process.env.GATEWAY_RATE_LIMIT_LLM ?? 60),
        imageGen: Number(process.env.GATEWAY_RATE_LIMIT_IMAGE ?? 10),
        audioSpeech: Number(process.env.GATEWAY_RATE_LIMIT_AUDIO ?? 30),
        telephony: Number(process.env.GATEWAY_RATE_LIMIT_TELEPHONY ?? 100),
      },
      circuitBreakerConfig: {
        maxRequestsPerWindow: Number(process.env.GATEWAY_CIRCUIT_BREAKER_MAX ?? 100),
        windowMs: Number(process.env.GATEWAY_CIRCUIT_BREAKER_WINDOW_MS ?? 10_000),
        pauseDurationMs: Number(process.env.GATEWAY_CIRCUIT_BREAKER_PAUSE_MS ?? 300_000),
      },
      rateLimitRepo: getRateLimitRepo(),
      circuitBreakerRepo: getCircuitBreakerRepo(),
      onCircuitBreakerTrip: (tenantId, instanceId, requestCount) => {
        logger.warn("Circuit breaker tripped", { tenantId, instanceId, requestCount });
        meter.emit({
          tenant: tenantId,
          cost: 0,
          charge: 0,
          capability: "circuit-breaker-trip",
          provider: "gateway",
          timestamp: Date.now(),
        });
      },
    });

    logger.info("Gateway mounted at /v1");

    // Mount readiness probe
    app.get("/health/ready", (c) => c.json({ status: "ready", service: "wopr-platform" }));

    // Mount admin health dashboard
    const adminHealth = createAdminHealthHandler({
      metrics,
      alertChecker,
      queryActiveBots: () => {
        const rows = billingDrizzle
          .select({ id: schema.botInstances.id })
          .from(schema.botInstances)
          .where(eq(schema.botInstances.billingState, "active"))
          .all();
        return rows.length;
      },
      queryCreditsConsumed24h: () => {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const row = billingDrizzle
          .select({
            total: sql<number>`COALESCE(SUM(${schema.meterEvents.charge}), 0)`,
          })
          .from(schema.meterEvents)
          .where(gte(schema.meterEvents.timestamp, cutoff))
          .get();
        return Math.round((row?.total ?? 0) * 100);
      },
    });
    adminHealth.use("*", scopedBearerAuthWithTenant(tokenMetadata, "admin"));
    app.route("/admin/health", adminHealth);
  }

  // Hydrate proxy route table from persisted profiles so tenant subdomains
  // are not lost on server restart.
  await hydrateProxyRoutes(getBotProfileRepo());

  // Wire nodes tRPC router deps
  setNodesRouterDeps({
    getRegistrationTokenStore,
    getNodeRepo,
    getConnectionRegistry,
    getBotInstanceRepo,
  });

  // Wire capabilities tRPC router deps (WOP-915: +listCapabilitySettings, +updateCapabilitySettings)
  {
    const tenantKeysDb = new Database(TENANT_KEYS_DB_PATH);
    applyPlatformPragmas(tenantKeysDb);
    const tenantKeyStore = new TenantKeyStore(tenantKeysDb);
    const capabilitySettingsStore = new CapabilitySettingsStore(tenantKeysDb);
    setCapabilitiesRouterDeps({
      getTenantKeyStore: () => tenantKeyStore as never,
      getCapabilitySettingsStore: () => capabilitySettingsStore,
      encrypt,
      deriveTenantKey: (tenantId: string, platformSecret: string) =>
        createHmac("sha256", platformSecret).update(`tenant:${tenantId}`).digest(),
      platformSecret: process.env.PLATFORM_SECRET,
      validateProviderKey: (provider, key) => validateProviderKey(provider as Provider, key),
    });
    logger.info("tRPC capabilities router initialized");
  }

  // Wire profile tRPC router deps (reads/writes better-auth user table directly)
  {
    const { BetterAuthUserRepository } = await import("./db/auth-user-repository.js");
    const AUTH_DB_PATH_LOCAL = process.env.AUTH_DB_PATH || "/data/platform/auth.db";
    const authDb = new Database(AUTH_DB_PATH_LOCAL);
    applyPlatformPragmas(authDb);
    const authUserRepo = new BetterAuthUserRepository(authDb);
    setProfileRouterDeps({
      getUser: (userId) => authUserRepo.getUser(userId),
      updateUser: (userId, data) => authUserRepo.updateUser(userId, data),
      changePassword: (userId, currentPassword, newPassword) =>
        authUserRepo.changePassword(userId, currentPassword, newPassword),
    });
    logger.info("tRPC profile router initialized");
  }

  // Wire model selection tRPC router deps
  {
    const { DrizzleTenantModelSelectionRepository } = await import("./db/tenant-model-selection-repository.js");
    const repo = new DrizzleTenantModelSelectionRepository(getDb());
    setModelSelectionRouterDeps({ getRepository: () => repo });
    logger.info("tRPC model selection router initialized");
  }

  // Wire settings tRPC router deps
  {
    const { resolveApiKey, buildPooledKeysMap } = await import("./security/tenant-keys/key-resolution.js");
    const { validateProviderKey, PROVIDER_ENDPOINTS } = await import("./security/key-validation.js");
    const { initTenantKeySchema } = await import("./security/tenant-keys/schema.js");
    const BetterSqlite = (await import("better-sqlite3")).default;

    const TENANT_KEYS_DB_PATH = process.env.TENANT_KEYS_DB_PATH || "/data/platform/tenant-keys.db";
    const tenantKeysDb = new BetterSqlite(TENANT_KEYS_DB_PATH);
    applyPlatformPragmas(tenantKeysDb);
    initTenantKeySchema(tenantKeysDb);
    const vaultEncKey = getVaultEncryptionKey(process.env.PLATFORM_SECRET);
    const pooledKeys = buildPooledKeysMap();

    setSettingsRouterDeps({
      getNotificationPrefsStore,
      testProvider: async (provider, tenantId) => {
        const validProvider = provider as Parameters<typeof validateProviderKey>[0];
        if (!PROVIDER_ENDPOINTS[validProvider]) {
          return { ok: false, error: `Unknown provider: ${provider}` };
        }
        const resolved = resolveApiKey(tenantKeysDb, tenantId, validProvider, vaultEncKey, pooledKeys);
        if (!resolved) {
          return { ok: false, error: "No API key configured for this provider" };
        }
        const start = Date.now();
        try {
          const result = await Promise.race([
            validateProviderKey(validProvider, resolved.key),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Provider test timed out")), 5_000)),
          ]);
          if (!result.valid) {
            return { ok: false, error: result.error ?? "Provider returned invalid key" };
          }
          return { ok: true, latencyMs: Date.now() - start };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Provider test failed" };
        }
      },
    });
    logger.info("tRPC settings router initialized");
  }

  // Wire billing tRPC router deps
  {
    const { CreditAdjustmentStore } = await import("./admin/credits/adjustment-store.js");
    const { initCreditAdjustmentSchema } = await import("./admin/credits/schema.js");
    const { MeterAggregator } = await import("./monetization/metering/aggregator.js");
    const { loadCreditPriceMap } = await import("./monetization/stripe/credit-prices.js");
    const { DrizzleTenantCustomerStore } = await import("./monetization/stripe/tenant-store.js");
    const { DrizzleSpendingLimitsRepository } = await import("./monetization/drizzle-spending-limits-repository.js");
    const { DrizzleAutoTopupSettingsRepository } = await import(
      "./monetization/credits/auto-topup-settings-repository.js"
    );
    const { StripePaymentProcessor } = await import("./monetization/stripe/stripe-payment-processor.js");
    const { DrizzlePayRamChargeStore } = await import("./monetization/payram/charge-store.js");

    const billingDb2 = new Database(BILLING_DB_PATH);
    applyPlatformPragmas(billingDb2);
    initCreditAdjustmentSchema(billingDb2);
    const billingDrizzle2 = createDb(billingDb2);

    const tenantStore = new DrizzleTenantCustomerStore(billingDrizzle2);
    const creditStore = new CreditAdjustmentStore(billingDb2);
    const meterAggregator = new MeterAggregator(billingDrizzle2);
    const spendingLimitsRepo = new DrizzleSpendingLimitsRepository(billingDrizzle2);
    const autoTopupSettingsStore = new DrizzleAutoTopupSettingsRepository(billingDrizzle2);
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(stripeKey);
      const priceMap = loadCreditPriceMap();

      const processor = new StripePaymentProcessor({
        stripe,
        tenantStore,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
        priceMap,
      });

      setBillingRouterDeps({
        processor,
        tenantStore,
        creditStore,
        meterAggregator,
        priceMap,
        dividendRepo: getDividendRepo(),
        spendingLimitsRepo,
        autoTopupSettingsStore,
        affiliateRepo: getAffiliateRepo(),
      });
      logger.info("tRPC billing router initialized");

      // Wire REST billing routes (Stripe webhooks, checkout, portal).
      // sigPenaltyRepo uses the platform DB (webhook_sig_penalties is in platform migrations).
      const payramChargeStore = process.env.PAYRAM_API_KEY ? new DrizzlePayRamChargeStore(billingDrizzle2) : undefined;

      setBillingDeps({
        processor,
        creditLedger: getCreditLedger(),
        meterAggregator,
        sigPenaltyRepo: new DrizzleSigPenaltyRepository(getDb()),
        affiliateRepo: getAffiliateRepo(),
        payramChargeStore,
      });
      logger.info("REST billing routes initialized");
    } else {
      logger.warn("STRIPE_SECRET_KEY not set — tRPC billing router not initialized");
    }
  }

  // Wire channel OAuth repository (used by /api/channel-oauth/* REST routes).
  // Uses the platform DB (oauth_states table is in platform migrations).
  setChannelOAuthRepo(new DrizzleOAuthStateRepository(getDb()));

  // Wire OrphanCleaner into NodeConnectionManager for stale container cleanup on node reboot
  initFleet();

  // Start heartbeat watchdog
  getHeartbeatWatchdog().start();

  // SOC 2 M4: Start system resource monitor (CPU/memory/disk threshold alerting)
  getSystemResourceMonitor().start();

  // SOC 2 H7: Ensure backup verifier singleton is available for admin-triggered verification
  getBackupVerifier();

  // Daily runtime deduction cron — charges tenants for active bots + resource tier surcharges.
  // Runs once every 24 h (offset by 1 min from midnight to avoid thundering herd).
  {
    const cronBillingDb = new Database(BILLING_DB_PATH);
    applyPlatformPragmas(cronBillingDb);
    const cronBillingDrizzle = createDb(cronBillingDb);
    const cronLedger = new CreditLedger(cronBillingDrizzle);
    const botInstanceRepo = getBotInstanceRepo();
    const getResourceTierCosts = buildResourceTierCosts(botInstanceRepo, (tenantId) =>
      botInstanceRepo
        .listByTenant(tenantId)
        .filter((b) => b.billingState === "active")
        .map((b) => b.id),
    );
    const DAILY_MS = 24 * 60 * 60 * 1000;
    setInterval(() => {
      void runRuntimeDeductions({
        ledger: cronLedger,
        getActiveBotCount: (tenantId) =>
          botInstanceRepo.listByTenant(tenantId).filter((b) => b.billingState === "active").length,
        getResourceTierCosts,
        onSuspend: (tenantId) => {
          logger.warn("Tenant suspended due to insufficient credits", { tenantId });
        },
      })
        .then((result) => {
          logger.info("Daily runtime deductions complete", result);
        })
        .catch((err) => {
          logger.error("Daily runtime deductions failed", { error: err instanceof Error ? err.message : String(err) });
        });
    }, DAILY_MS);
    logger.info("Daily runtime deduction cron scheduled (24h interval)");
  }

  const server = serve({ fetch: app.fetch, port }, () => {
    logger.info(`wopr-platform listening on http://0.0.0.0:${port}`);
  });

  // Set up WebSocket server for node agent connections
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const pathname = url.pathname;
      const match = pathname.match(/^\/internal\/nodes\/([^/]+)\/ws$/);

      if (match) {
        const nodeId = match[1];
        const authHeader = req.headers.authorization;
        const bearer = authHeader?.replace(/^Bearer\s+/i, "");

        // Path 1: Static NODE_SECRET (backwards-compatible)
        const staticAuthResult = validateNodeAuth(authHeader);
        if (staticAuthResult === true) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            acceptAndWireWebSocket(nodeId, ws);
          });
          return;
        }

        // Path 2: Per-node persistent secret for self-hosted nodes
        if (bearer) {
          const nodeBySecret = getNodeRepo().getBySecret(bearer);
          if (nodeBySecret && nodeBySecret.id === nodeId) {
            wss.handleUpgrade(req, socket, head, (ws) => {
              acceptAndWireWebSocket(nodeId, ws);
            });
            return;
          }
        }

        // No valid auth found
        if (staticAuthResult === null && !bearer) {
          // NODE_SECRET not configured and no bearer provided
          socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        } else {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        }
        socket.destroy();
      } else {
        socket.destroy();
      }
    } catch (err) {
      logger.error("WebSocket upgrade error", { err });
      socket.destroy();
    }
  });
}
