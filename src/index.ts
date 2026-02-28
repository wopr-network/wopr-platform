import { createHmac } from "node:crypto";
import { serve } from "@hono/node-server";
import { eq, gte, sql } from "drizzle-orm";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { RateStore } from "./admin/rates/rate-store.js";
import { app } from "./api/app.js";
import { DrizzleOAuthStateRepository } from "./api/drizzle-oauth-state-repository.js";
import { DrizzleSigPenaltyRepository } from "./api/drizzle-sig-penalty-repository.js";
import { setBillingDeps } from "./api/routes/billing.js";
import { setBotPluginDeps } from "./api/routes/bot-plugins.js";
import { setChannelOAuthRepo } from "./api/routes/channel-oauth.js";
import { setChatDeps } from "./api/routes/chat.js";
import { setFleetDeps } from "./api/routes/fleet.js";
import { validateNodeAuth } from "./api/routes/internal-nodes.js";
import { setOnboardingDeps } from "./api/routes/onboarding.js";
import { setSetupDeps } from "./api/routes/setup.js";
import { buildTokenMetadataMap, scopedBearerAuthWithTenant } from "./auth/index.js";
import { EchoChatBackend } from "./chat/chat-backend.js";
import { config } from "./config/index.js";
import { logger } from "./config/logger.js";
import { runMigrations } from "./db/migrate.js";
import * as schema from "./db/schema/index.js";
import { NotificationService } from "./email/notification-service.js";
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
  getCreditTransactionRepo,
  getDaemonManager,
  getDb,
  getDividendRepo,
  getFleetEventRepo,
  getGraduationService,
  getHeartbeatProcessor,
  getHeartbeatWatchdog,
  getNodeRegistrar,
  getNodeRepo,
  getNotificationPrefsStore,
  getNotificationQueueStore,
  getOnboardingService,
  getOnboardingSessionRepo,
  getOrgMembershipRepo,
  getOrgService,
  getPool,
  getRateLimitRepo,
  getRegistrationTokenStore,
  getSetupService,
  getSetupSessionRepo,
  getSystemResourceMonitor,
  getTenantAddonRepo,
  initFleet,
} from "./fleet/services.js";
import { DrizzleSpendingCapStore } from "./fleet/spending-cap-repository.js";
import { mountGateway } from "./gateway/index.js";
import { createCachedRateLookup } from "./gateway/rate-lookup.js";
import type { GatewayTenant } from "./gateway/types.js";
import { buildAddonCosts } from "./monetization/addons/addon-cron.js";
import { BudgetChecker } from "./monetization/budget/budget-checker.js";
import { Credit } from "./monetization/credit.js";
import { runDividendCron } from "./monetization/credits/dividend-cron.js";
import { runDividendDigestCron } from "./monetization/credits/dividend-digest-cron.js";
import { buildResourceTierCosts, runRuntimeDeductions } from "./monetization/credits/runtime-cron.js";
import { DrizzleWebhookSeenRepository } from "./monetization/drizzle-webhook-seen-repository.js";
import { MeterEmitter } from "./monetization/metering/emitter.js";
import { runReconciliation } from "./monetization/metering/reconciliation-cron.js";
import {
  DrizzleAdapterUsageRepository,
  DrizzleUsageSummaryRepository,
} from "./monetization/metering/reconciliation-repository.js";
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
import { DrizzleTenantKeyLookup } from "./onboarding/drizzle-tenant-key-repository.js";
import { checkProviderConfigured } from "./onboarding/provider-check.js";
import { hydrateProxyRoutes } from "./proxy/singleton.js";
import { DrizzleCredentialRepository } from "./security/credential-vault/credential-repository.js";
import { CredentialVaultStore, getVaultEncryptionKey } from "./security/credential-vault/store.js";
import { encrypt } from "./security/encryption.js";
import { validateProviderKey } from "./security/key-validation.js";
import { CapabilitySettingsStore } from "./security/tenant-keys/capability-settings-store.js";
import { TenantKeyStore } from "./security/tenant-keys/schema.js";
import type { Provider } from "./security/types.js";
import {
  setAddonRouterDeps,
  setAdminRouterDeps,
  setBillingRouterDeps,
  setCapabilitiesRouterDeps,
  setFleetRouterDeps,
  setModelSelectionRouterDeps,
  setNodesRouterDeps,
  setOrgKeysRouterDeps,
  setOrgRouterDeps,
  setProfileRouterDeps,
  setSettingsRouterDeps,
} from "./trpc/index.js";

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
  logger.info("Applying pending database migrations...");
  await runMigrations(getPool());
  logger.info("Database migrations complete");

  // ── Gateway wiring ──────────────────────────────────────────────────────────
  // Mount /v1/* gateway routes. Must be done before serve() so routes are
  // registered. Provider API keys are optional — omitting one disables that
  // capability silently (gateway returns 503 for unconfigured providers).

  // Late-bound callback for usage-based auto top-up (WOP-1084).
  // Declared here (before gateway block) and assigned below in the Stripe block
  // after chargeAutoTopup deps are available.
  let usageTopupCallback: ((tenantId: string) => void) | undefined;

  {
    // All tables live in platform.db (drizzle-kit migrations target).
    // BILLING_DB_PATH was a legacy holdover — use getDb() throughout.
    const metricsRepo = new DrizzleMetricsRepository(getDb());
    const metrics = new MetricsCollector(metricsRepo);
    const fleetEventRepo = getFleetEventRepo();
    const alerts = buildAlerts(metrics, fleetEventRepo);

    // ── PagerDuty integration ────────────────────────────────────────────────
    const pagerduty = new PagerDutyNotifier(config.pagerduty);

    const criticalAlerts = buildCriticalAlerts({
      metrics,
      dbHealthCheck: () => {
        try {
          // pg pool health: check if pool is not ended
          const pool = getPool();
          return !pool.ended;
        } catch {
          return false;
        }
      },
      authHealthCheck: () => {
        // Auth is co-located — if platform is running, auth is up.
        return true;
      },
      gatewayHealthCheck: async () => {
        const window = await metrics.getWindow(1);
        const last5m = await metrics.getWindow(5);
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

    const rateStore = new RateStore(getDb());

    const meter = new MeterEmitter(getDb());
    const budgetChecker = new BudgetChecker(getDb());
    const creditLedger = getCreditLedger();

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
    const credentialRepo = new DrizzleCredentialRepository(getDb());
    const credentialVault = new CredentialVaultStore(credentialRepo, vaultKey);
    setBotPluginDeps({ credentialVault, meterEmitter: meter, botInstanceRepo: getBotInstanceRepo() });

    const { DrizzleSpendingLimitsRepository } = await import("./monetization/drizzle-spending-limits-repository.js");
    const spendingLimitsRepo = new DrizzleSpendingLimitsRepository(getDb());

    mountGateway(app, {
      meter,
      budgetChecker,
      creditLedger,
      spendingCapStore: new DrizzleSpendingCapStore(getDb()),
      spendingLimitsRepo,
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
          cost: Credit.ZERO,
          charge: Credit.ZERO,
          capability: "circuit-breaker-trip",
          provider: "gateway",
          timestamp: Date.now(),
        });
      },
      // Fire-and-forget usage-based auto top-up after every debit (WOP-1084).
      // Callback is assigned below once Stripe deps are available.
      onDebitComplete: (tenantId) => {
        if (usageTopupCallback) usageTopupCallback(tenantId);
      },
      onBalanceExhausted: (tenantId, newBalanceCents) => {
        logger.warn("Credit balance exhausted via gateway", { tenantId, newBalanceCents });

        // Fire-and-forget: look up email and enqueue notification
        (async () => {
          try {
            // raw SQL: better-auth manages the "user" table outside Drizzle
            const { rows } = await getPool().query<{ email: string }>(
              `SELECT email FROM "user" WHERE id = $1 LIMIT 1`,
              [tenantId],
            );
            const email = rows[0]?.email;
            if (!email) return;

            const notificationService = new NotificationService(
              getNotificationQueueStore(),
              process.env.APP_BASE_URL ?? "https://app.wopr.bot",
            );
            notificationService.notifyCreditsDepeleted(tenantId, email);
          } catch (err) {
            logger.error("Failed to send balance exhausted notification", {
              tenantId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      },
      onSpendAlertCrossed: (tenantId) => {
        // Fire-and-forget: check if monthly spend has crossed alertAt threshold
        (async () => {
          try {
            const { checkSpendAlert } = await import("./gateway/spend-alert.js");
            const { DrizzleSpendingLimitsRepository } = await import(
              "./monetization/drizzle-spending-limits-repository.js"
            );
            const { DrizzleSpendingCapStore } = await import("./fleet/spending-cap-repository.js");
            const { DrizzleBillingEmailRepository } = await import("./email/drizzle-billing-email-repository.js");

            const notificationService = new NotificationService(
              getNotificationQueueStore(),
              process.env.APP_BASE_URL ?? "https://app.wopr.bot",
            );

            await checkSpendAlert(
              {
                spendingLimitsRepo: new DrizzleSpendingLimitsRepository(getDb()),
                spendingCapStore: new DrizzleSpendingCapStore(getDb()),
                billingEmailRepo: new DrizzleBillingEmailRepository(getDb()),
                notificationService,
                resolveEmail: async (tid) => {
                  // raw SQL: better-auth manages the "user" table outside Drizzle
                  const { rows } = await getPool().query<{ email: string }>(
                    `SELECT email FROM "user" WHERE id = $1 LIMIT 1`,
                    [tid],
                  );
                  return rows[0]?.email ?? null;
                },
              },
              tenantId,
            );
          } catch (err) {
            logger.error("Spend alert check failed", {
              tenantId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      },
    });

    logger.info("Gateway mounted at /v1");

    // Mount readiness probe
    app.get("/health/ready", (c) => c.json({ status: "ready", service: "wopr-platform" }));

    // Mount admin health dashboard
    const adminHealth = createAdminHealthHandler({
      metrics,
      alertChecker,
      queryActiveBots: async () => {
        const rows = await getDb()
          .select({ id: schema.botInstances.id })
          .from(schema.botInstances)
          .where(eq(schema.botInstances.billingState, "active"));
        return rows.length;
      },
      queryCreditsConsumed24h: async () => {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const row = (
          await getDb()
            .select({
              total: sql<number>`COALESCE(SUM(${schema.meterEvents.charge}), 0)`,
            })
            .from(schema.meterEvents)
            .where(gte(schema.meterEvents.timestamp, cutoff))
        )[0];
        return Math.round((row?.total ?? 0) / 10_000_000);
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

  // Wire org tRPC router deps
  {
    const { BetterAuthUserRepository } = await import("./db/auth-user-repository.js");
    setOrgRouterDeps({ orgService: getOrgService(), authUserRepo: new BetterAuthUserRepository(getPool()) });
  }

  // Wire capabilities tRPC router deps (WOP-915: +listCapabilitySettings, +updateCapabilitySettings)
  {
    const tenantKeyStore = new TenantKeyStore(getDb());
    const capabilitySettingsStore = new CapabilitySettingsStore(getDb());
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
    const authUserRepo = new BetterAuthUserRepository(getPool());
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
    const vaultEncKey = getVaultEncryptionKey(process.env.PLATFORM_SECRET);
    const pooledKeys = buildPooledKeysMap();

    setSettingsRouterDeps({
      getNotificationPrefsStore,
      testProvider: async (provider, tenantId) => {
        const validProvider = provider as Parameters<typeof validateProviderKey>[0];
        if (!PROVIDER_ENDPOINTS[validProvider]) {
          return { ok: false, error: `Unknown provider: ${provider}` };
        }
        const resolved = await resolveApiKey(getDb(), tenantId, validProvider, vaultEncKey, pooledKeys);
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

  // Wire org-keys tRPC router deps (WOP-1003: org-scoped BYOK key resolution)
  {
    const { resolveApiKeyWithOrgFallback } = await import("./security/tenant-keys/org-key-resolution.js");
    const { RoleStore } = await import("./admin/roles/role-store.js");
    const orgKeysTenantKeyStore = new TenantKeyStore(getDb());
    const roleStore = new RoleStore(getDb());
    const orgVaultEncKey = getVaultEncryptionKey(process.env.PLATFORM_SECRET);
    const deriveTenantKey2 = (tenantId: string, platformSecret: string) =>
      createHmac("sha256", platformSecret).update(`tenant:${tenantId}`).digest();
    const { buildPooledKeysMap: buildPooledKeysMap2, resolveApiKey: resolveApiKey2 } = await import(
      "./security/tenant-keys/key-resolution.js"
    );
    const pooledKeys2 = buildPooledKeysMap2();

    setOrgKeysRouterDeps({
      getTenantKeyStore: () => orgKeysTenantKeyStore as never,
      encrypt,
      deriveTenantKey: deriveTenantKey2,
      platformSecret: process.env.PLATFORM_SECRET,
      getOrgTenantIdForUser: (_userId: string, memberTenantId: string) => {
        return getOrgMembershipRepo().getOrgTenantIdForMember(memberTenantId);
      },
      getUserRoleInTenant: (userId: string, tenantId: string) => {
        return roleStore.getRole(userId, tenantId);
      },
    });
    logger.info("tRPC org-keys router initialized");

    // Override settings testProvider to use org-aware key resolution
    // This ensures org keys are checked when testing provider connectivity
    const { validateProviderKey: validateProviderKey2, PROVIDER_ENDPOINTS: PROVIDER_ENDPOINTS2 } = await import(
      "./security/key-validation.js"
    );
    setSettingsRouterDeps({
      getNotificationPrefsStore,
      testProvider: async (provider, tenantId) => {
        const validProvider = provider as Parameters<typeof validateProviderKey2>[0];
        if (!PROVIDER_ENDPOINTS2[validProvider]) {
          return { ok: false, error: `Unknown provider: ${provider}` };
        }
        const resolved = await resolveApiKeyWithOrgFallback(
          async (tid, prov, encKey) => (await resolveApiKey2(getDb(), tid, prov, encKey, new Map()))?.key ?? null,
          tenantId,
          validProvider,
          orgVaultEncKey,
          pooledKeys2,
          (tid) =>
            createHmac("sha256", process.env.PLATFORM_SECRET ?? "")
              .update(`tenant:${tid}`)
              .digest(),
          getOrgMembershipRepo(),
        );
        if (!resolved) {
          return { ok: false, error: "No API key configured for this provider" };
        }
        const start = Date.now();
        try {
          const result = await Promise.race([
            validateProviderKey2(validProvider, resolved.key),
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
  }

  // Wire billing tRPC router deps
  {
    const { MeterAggregator } = await import("./monetization/metering/aggregator.js");
    const { loadCreditPriceMap } = await import("./monetization/stripe/credit-prices.js");
    const { DrizzleTenantCustomerStore } = await import("./monetization/stripe/tenant-store.js");
    const { DrizzleSpendingLimitsRepository } = await import("./monetization/drizzle-spending-limits-repository.js");
    const { DrizzleAutoTopupSettingsRepository } = await import(
      "./monetization/credits/auto-topup-settings-repository.js"
    );
    const { StripePaymentProcessor } = await import("./monetization/stripe/stripe-payment-processor.js");
    const { DrizzlePayRamChargeStore } = await import("./monetization/payram/charge-store.js");

    const tenantStore = new DrizzleTenantCustomerStore(getDb());
    const meterAggregator = new MeterAggregator(getDb());
    const spendingLimitsRepo = new DrizzleSpendingLimitsRepository(getDb());
    const autoTopupSettingsStore = new DrizzleAutoTopupSettingsRepository(getDb());
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
        creditLedger: getCreditLedger(),
        replayGuard: new DrizzleWebhookSeenRepository(getDb()),
      });

      // Create PayRam deps before tRPC router so both REST and tRPC can share them.
      const payramChargeStore = process.env.PAYRAM_API_KEY ? new DrizzlePayRamChargeStore(getDb()) : undefined;
      let payramClient: import("payram").Payram | undefined;
      if (process.env.PAYRAM_API_KEY) {
        const { createPayRamClient, loadPayRamConfig } = await import("./monetization/payram/client.js");
        const payramConfig = loadPayRamConfig();
        if (payramConfig) {
          payramClient = createPayRamClient(payramConfig);
        }
      }

      const { AuditLogger } = await import("./audit/logger.js");
      const { DrizzleAuditLogRepository } = await import("./audit/audit-log-repository.js");
      const billingAuditLogger = new AuditLogger(new DrizzleAuditLogRepository(getDb()));

      setAddonRouterDeps({ addonRepo: getTenantAddonRepo() });

      setBillingRouterDeps({
        processor,
        tenantStore,
        creditLedger: getCreditLedger(),
        meterAggregator,
        priceMap,
        dividendRepo: getDividendRepo(),
        spendingLimitsRepo,
        autoTopupSettingsStore,
        affiliateRepo: getAffiliateRepo(),
        payramClient,
        payramChargeStore,
        auditLogger: billingAuditLogger,
      });
      logger.info("tRPC billing router initialized");

      // Wire admin tRPC router deps — ban cascade needs Stripe + auto-topup repo (WOP-1064)
      {
        const { detachAllPaymentMethods } = await import("./monetization/stripe/payment-methods.js");
        const { getTenantStatusRepo, getAutoTopupSettingsRepo } = await import("./fleet/services.js");
        const { AdminAuditLog } = await import("./admin/audit-log.js");
        const { DrizzleAdminAuditLogRepository } = await import("./admin/admin-audit-log-repository.js");
        const { AdminUserStore } = await import("./admin/users/user-store.js");
        const { BotBilling } = await import("./monetization/credits/bot-billing.js");
        const { DrizzleAffiliateFraudAdminRepository } = await import(
          "./monetization/affiliate/affiliate-admin-repository.js"
        );
        setAdminRouterDeps({
          getAuditLog: () => new AdminAuditLog(new DrizzleAdminAuditLogRepository(getDb())),
          getCreditLedger: () => getCreditLedger(),
          getUserStore: () => new AdminUserStore(getDb()),
          getTenantStatusStore: () => getTenantStatusRepo(),
          getBotBilling: () => new BotBilling(getDb()),
          getAutoTopupSettingsRepo: () => getAutoTopupSettingsRepo(),
          detachAllPaymentMethods: (tenantId: string) => detachAllPaymentMethods(stripe, tenantStore, tenantId),
          getAffiliateFraudAdminRepo: () => new DrizzleAffiliateFraudAdminRepository(getDb()),
        });
        logger.info("tRPC admin router initialized");
      }

      // Hourly auto-topup schedule cron — charges tenants with schedule-based auto-topup due.
      // checkTenantStatus guard ensures banned/suspended tenants are skipped (WOP-1064).
      {
        const { runScheduledTopups } = await import("./monetization/credits/auto-topup-schedule.js");
        const { chargeAutoTopup } = await import("./monetization/credits/auto-topup-charge.js");
        const { getTenantStatusRepo, getAutoTopupEventLogRepo } = await import("./fleet/services.js");
        const { checkTenantStatus } = await import("./admin/tenant-status/tenant-status-middleware.js");
        const HOUR_MS = 60 * 60 * 1000;
        setInterval(() => {
          void runScheduledTopups({
            settingsRepo: autoTopupSettingsStore,
            chargeAutoTopup: (tenantId, amountCents, source) =>
              chargeAutoTopup(
                { stripe, tenantStore, creditLedger: getCreditLedger(), eventLogRepo: getAutoTopupEventLogRepo() },
                tenantId,
                amountCents,
                source,
              ),
            checkTenantStatus: (tenantId) => checkTenantStatus(getTenantStatusRepo(), tenantId),
          })
            .then((result) => {
              logger.info("Scheduled auto-topup cron complete", result);
            })
            .catch((err) => {
              logger.error("Scheduled auto-topup cron failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }, HOUR_MS);
        logger.info("Hourly scheduled auto-topup cron started");
      }

      // Wire usage-based auto top-up into gateway debit pipeline (WOP-1084).
      // Assigns usageTopupCallback so the gateway's onDebitComplete fires after every debit.
      {
        const { maybeTriggerUsageTopup } = await import("./monetization/credits/auto-topup-usage.js");
        const { chargeAutoTopup } = await import("./monetization/credits/auto-topup-charge.js");
        const { getTenantStatusRepo, getAutoTopupEventLogRepo } = await import("./fleet/services.js");
        const { checkTenantStatus } = await import("./admin/tenant-status/tenant-status-middleware.js");

        const usageTopupDeps: import("./monetization/credits/auto-topup-usage.js").UsageTopupDeps = {
          settingsRepo: autoTopupSettingsStore,
          creditLedger: getCreditLedger(),
          chargeAutoTopup: (tenantId, amount, source) =>
            chargeAutoTopup(
              { stripe, tenantStore, creditLedger: getCreditLedger(), eventLogRepo: getAutoTopupEventLogRepo() },
              tenantId,
              amount,
              source,
            ),
          checkTenantStatus: (tenantId) => checkTenantStatus(getTenantStatusRepo(), tenantId),
        };

        usageTopupCallback = (tenantId) => {
          maybeTriggerUsageTopup(usageTopupDeps, tenantId).catch((err) =>
            logger.error("Usage auto-topup failed", {
              tenantId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        };
        logger.info("Usage-based auto top-up wired into gateway (WOP-1084)");
      }

      // Wire REST billing routes (Stripe webhooks, checkout, portal).
      // sigPenaltyRepo uses the platform DB (webhook_sig_penalties is in platform migrations).

      setBillingDeps({
        processor,
        creditLedger: getCreditLedger(),
        meterAggregator,
        sigPenaltyRepo: new DrizzleSigPenaltyRepository(getDb()),
        replayGuard: new DrizzleWebhookSeenRepository(getDb()),
        payramReplayGuard: new DrizzleWebhookSeenRepository(getDb()),
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

  // Wire fleet tRPC router deps (storage tier procedures + bot billing)
  {
    const { getBotBilling, getCreditLedger } = await import("./fleet/services.js");
    const DockerLib = (await import("dockerode")).default;
    const { ProfileStore } = await import("./fleet/profile-store.js");
    const { FleetManager } = await import("./fleet/fleet-manager.js");
    const { NetworkPolicy } = await import("./network/network-policy.js");
    const { getProxyManager } = await import("./proxy/singleton.js");
    const { loadProfileTemplates, defaultTemplatesDir } = await import("./fleet/profile-loader.js");
    const tRpcDocker = new DockerLib();
    const tRpcStore = new ProfileStore(process.env.FLEET_DATA_DIR || "/data/fleet");
    const tRpcNetworkPolicy = new NetworkPolicy(tRpcDocker);
    const tRpcFleet = new FleetManager(tRpcDocker, tRpcStore, config.discovery, tRpcNetworkPolicy, getProxyManager());
    let _templates: import("./fleet/profile-schema.js").ProfileTemplate[] | null = null;
    setFleetRouterDeps({
      getFleetManager: () => tRpcFleet,
      getTemplates: () => {
        if (!_templates) _templates = loadProfileTemplates(defaultTemplatesDir());
        return _templates;
      },
      getCreditLedger: () => getCreditLedger(),
      getBotBilling: () => getBotBilling(),
    });
    logger.info("tRPC fleet router initialized");

    // Wire REST fleet routes with the same billing deps
    const { getEmailVerifier } = await import("./auth/better-auth.js");
    setFleetDeps({
      creditLedger: getCreditLedger(),
      botBilling: getBotBilling(),
      emailVerifier: getEmailVerifier(),
    });
    logger.info("REST fleet routes initialized");
  }

  // Start heartbeat watchdog
  getHeartbeatWatchdog().start();

  // SOC 2 M4: Start system resource monitor (CPU/memory/disk threshold alerting)
  getSystemResourceMonitor().start();

  // SOC 2 H7: Ensure backup verifier singleton is available for admin-triggered verification
  getBackupVerifier();

  // Run better-auth migrations before accepting requests.
  // better-auth does not auto-migrate — runMigrations() must be called explicitly.
  {
    const { runAuthMigrations } = await import("./auth/better-auth.js");
    await runAuthMigrations();
    logger.info("better-auth migrations applied");
  }

  // Daily runtime deduction cron — charges tenants for active bots + resource tier surcharges.
  // Runs once every 24 h (offset by 1 min from midnight to avoid thundering herd).
  {
    const cronLedger = getCreditLedger();
    const botInstanceRepo = getBotInstanceRepo();
    const getResourceTierCosts = buildResourceTierCosts(botInstanceRepo, async (tenantId) => {
      const bots = await botInstanceRepo.listByTenant(tenantId);
      return bots.filter((b) => b.billingState === "active").map((b) => b.id);
    });
    const getAddonCosts = buildAddonCosts(getTenantAddonRepo());
    const DAILY_MS = 24 * 60 * 60 * 1000;
    setInterval(() => {
      const today = new Date().toISOString().slice(0, 10);
      void runRuntimeDeductions({
        ledger: cronLedger,
        date: today,
        getActiveBotCount: async (tenantId) => {
          const bots = await botInstanceRepo.listByTenant(tenantId);
          return bots.filter((b) => b.billingState === "active").length;
        },
        getResourceTierCosts,
        getAddonCosts,
        onSuspend: (tenantId) => {
          logger.warn("Tenant suspended due to insufficient credits", { tenantId });
        },
      })
        .then((result) => {
          logger.info("Daily runtime deductions complete", result);
        })
        .catch((err) => {
          logger.error("Daily runtime deductions failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, DAILY_MS);
    logger.info("Daily runtime deduction cron scheduled (24h interval)");
  }

  // Daily community dividend distribution — pool = sum(purchases) × matchRate, split among active users.
  // Runs once every 24h. Idempotent: skips if already ran for the target date.
  {
    const dividendMatchRate = config.billing.dividendMatchRate;
    const dividendTxRepo = getCreditTransactionRepo();
    const dividendLedger = getCreditLedger();
    const DAILY_MS = 24 * 60 * 60 * 1000;
    setInterval(() => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const targetDate = yesterday.toISOString().slice(0, 10);
      void runDividendCron({
        creditTransactionRepo: dividendTxRepo,
        ledger: dividendLedger,
        matchRate: dividendMatchRate,
        targetDate,
      })
        .then((result) => {
          logger.info("Daily dividend distribution complete", result);
        })
        .catch((err) => {
          logger.error("Daily dividend distribution failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, DAILY_MS);
    logger.info("Daily dividend distribution cron scheduled (24h interval)");
  }

  // Weekly community dividend digest emails — summarizes last 7 days of dividends for each tenant.
  // Runs once every 7 days.
  {
    const appBaseUrl = process.env.PLATFORM_URL ?? "https://api.wopr.bot";
    const notificationService = new NotificationService(getNotificationQueueStore(), appBaseUrl);
    const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
    setInterval(() => {
      const today = new Date().toISOString().slice(0, 10);
      void runDividendDigestCron({
        dividendRepo: getDividendRepo(),
        notificationService,
        appBaseUrl,
        digestDate: today,
      })
        .then((result) => {
          logger.info("Weekly dividend digest complete", result);
        })
        .catch((err) => {
          logger.error("Weekly dividend digest failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, WEEKLY_MS);
    logger.info("Weekly dividend digest cron scheduled (7d interval)");
  }

  // Daily metering/ledger drift reconciliation — detects discrepancies between metered usage and ledger debits.
  // Runs once every 24h, reconciling the previous day's data.
  {
    const reconciliationDb = getDb();
    const usageSummaryRepo = new DrizzleUsageSummaryRepository(reconciliationDb);
    const adapterUsageRepo = new DrizzleAdapterUsageRepository(reconciliationDb);
    const DAILY_MS = 24 * 60 * 60 * 1000;
    setInterval(() => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const targetDate = yesterday.toISOString().slice(0, 10);
      void runReconciliation({
        usageSummaryRepo,
        adapterUsageRepo,
        targetDate,
        onFlagForReview: (tenantId, driftRaw) => {
          logger.error("Tenant flagged for billing review — drift exceeds threshold", {
            tenantId,
            driftRaw,
            driftDisplay: Credit.fromRaw(Math.abs(driftRaw)).toDisplayString(),
          });
        },
      })
        .then((result) => {
          logger.info("Daily metering/ledger reconciliation complete", {
            date: result.date,
            tenantsChecked: result.tenantsChecked,
            discrepancies: result.discrepancies.length,
            flagged: result.flagged.length,
          });
        })
        .catch((err) => {
          logger.error("Daily metering/ledger reconciliation failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, DAILY_MS);
    logger.info("Daily metering/ledger reconciliation cron scheduled (24h interval)");
  }

  // Wire onboarding deps and start WOPR daemon if enabled (WOP-1020)
  {
    const { loadOnboardingConfig } = await import("./onboarding/config.js");
    const onboardingCfg = loadOnboardingConfig();
    setOnboardingDeps(getOnboardingService(), getOnboardingSessionRepo(), getGraduationService());
    // Wire setup route deps (WOP-1034, WOP-1035, WOP-1055)
    const { pluginRegistry } = await import("./api/routes/marketplace-registry.js");
    const onboardingSessionRepoForSetup = getOnboardingSessionRepo();
    const setupSessionRepoForCheck = getSetupSessionRepo();
    const tenantKeyLookup = new DrizzleTenantKeyLookup(getDb());
    const { ProfileStore: SetupProfileStore } = await import("./fleet/profile-store.js");
    const { dispatchEnvUpdate: dispatchEnvUpdateFn } = await import("./fleet/dispatch-env-update.js");
    const { getPluginConfigRepo } = await import("./fleet/services.js");
    setSetupDeps({
      pluginRegistry,
      setupSessionRepo: setupSessionRepoForCheck,
      onboardingService: getOnboardingService(),
      setupService: getSetupService(),
      checkProvider: async (sessionId: string) => {
        // Look up the onboarding session to get the userId (which is the tenantId)
        const onboardingSession = await onboardingSessionRepoForSetup.getById(sessionId);
        if (!onboardingSession?.userId) {
          return { configured: false };
        }
        return checkProviderConfigured(tenantKeyLookup, onboardingSession.userId, {
          setupRepo: setupSessionRepoForCheck,
          sessionId,
        });
      },
      pluginConfigRepo: getPluginConfigRepo(),
      profileStore: new SetupProfileStore(process.env.FLEET_DATA_DIR || "/data/fleet"),
      dispatchEnvUpdate: (botId, tenantId, env) => dispatchEnvUpdateFn(botId, tenantId, env, getBotInstanceRepo()),
      platformEncryptionSecret: process.env.PLATFORM_ENCRYPTION_SECRET ?? "",
    });

    // Setup session cleanup — rolls back sessions stale >30 minutes (WOP-1037)
    {
      const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
      const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
      setInterval(() => {
        void getSetupService()
          .cleanupStaleSessions(STALE_THRESHOLD_MS)
          .then((results) => {
            if (results.length > 0) {
              logger.info("Stale setup sessions rolled back", { count: results.length });
            }
          })
          .catch((err) => {
            logger.error("Setup session cleanup failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }, CLEANUP_INTERVAL_MS);
      logger.info("Setup session cleanup scheduled (15m interval, 30m stale threshold)");
    }

    // Wire chat deps (echo backend until WOPR instance integration)
    setChatDeps({ backend: new EchoChatBackend() });
    if (onboardingCfg.enabled) {
      getDaemonManager()
        .start()
        .catch((err) => {
          logger.error("[onboarding] WOPR daemon failed to start", { err });
        });
      // Graceful shutdown: stop daemon before process exits
      const shutdownDaemon = () => {
        getDaemonManager()
          .stop()
          .catch((err) => logger.error("[onboarding] daemon stop error", { err }));
      };
      process.on("SIGTERM", shutdownDaemon);
      process.on("SIGINT", shutdownDaemon);
      logger.info("[onboarding] WOPR daemon startup initiated");
    } else {
      logger.info("[onboarding] WOPR daemon disabled (ONBOARDING_ENABLED=false)");
    }
  }

  const server = serve({ fetch: app.fetch, port }, () => {
    logger.info(`wopr-platform listening on http://0.0.0.0:${port}`);
  });

  // Set up WebSocket server for node agent connections
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
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
            const nodeBySecret = await getNodeRepo().getBySecret(bearer);
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
    })();
  });
}
