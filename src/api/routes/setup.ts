import { randomUUID } from "node:crypto";
import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { deriveInstanceKey, encrypt } from "@wopr-network/platform-core/security";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../../config/logger.js";
import { applyDependencyConfigs, type DependencyConfigResult } from "../../fleet/apply-dependency-configs.js";
import type { OnboardingService } from "../../onboarding/onboarding-service.js";
import type { ProviderStatus } from "../../onboarding/provider-check.js";
import type { IPluginConfigRepository } from "../../setup/plugin-config-repository.js";
import type { SetupService } from "../../setup/setup-service.js";
import type { ISetupSessionRepository } from "../../setup/setup-session-repository.js";
import type { PluginManifest } from "./marketplace-registry.js";

/** Extract authenticated user from context, or null if not set. */
function getUser(c: { get(key: string): unknown }): { id: string } | null {
  try {
    const user = c.get("user") as { id: string } | undefined;
    return user ?? null;
  } catch {
    return null;
  }
}

const setupRequestSchema = z.object({
  sessionId: z.string().min(1),
  pluginId: z.string().min(1),
});

const sessionIdSchema = z.object({ setupSessionId: z.string().min(1) });

const saveConfigSchema = z.object({
  setupSessionId: z.string().min(1),
  botId: z.string().uuid(),
  values: z.record(z.string(), z.unknown()),
});

type ProfileStoreLike = {
  get(id: string): Promise<{ id: string; tenantId: string; env: Record<string, string> } | null>;
  save(profile: { id: string; tenantId: string; env: Record<string, string> }): Promise<void>;
};

export interface SetupRouteDeps {
  pluginRegistry: PluginManifest[];
  setupSessionRepo: ISetupSessionRepository;
  onboardingService: Pick<OnboardingService, "inject">;
  setupService: SetupService;
  checkProvider?: (sessionId: string) => Promise<ProviderStatus>;
  pluginConfigRepo: IPluginConfigRepository;
  profileStore: ProfileStoreLike;
  dispatchEnvUpdate: (
    botId: string,
    tenantId: string,
    env: Record<string, string>,
  ) => Promise<{ dispatched: boolean; dispatchError?: string }>;
  dispatchPluginInstall: (
    botId: string,
    npmPackage: string,
  ) => Promise<{ dispatched: boolean; dispatchError?: string }>;
  dispatchPluginConfig: (
    botId: string,
    pluginId: string,
    config: Record<string, unknown>,
  ) => Promise<{ dispatched: boolean; dispatchError?: string }>;
  fetchPluginDependencies: (botId: string, pluginName: string) => Promise<string[]>;
  platformEncryptionSecret: string;
}

export function createSetupRoutes(deps: SetupRouteDeps): Hono {
  const routes = new Hono();

  routes.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = setupRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const { sessionId, pluginId } = parsed.data;

    // 1. Look up plugin manifest
    const manifest = deps.pluginRegistry.find((p) => p.id === pluginId);
    if (!manifest) {
      return c.json({ error: `Plugin not found: ${pluginId}` }, 404);
    }

    // 2. Check for existing in-progress setup session
    const existing = await deps.setupSessionRepo.findBySessionId(sessionId);
    if (existing) {
      return c.json({ error: "Setup already in progress for this session", setupSessionId: existing.id }, 409);
    }

    // 3. Determine npm package name from manifest
    const npmPackage = manifest.install?.[0];
    if (!npmPackage) {
      return c.json({ error: `Plugin manifest missing install package specification: ${pluginId}` }, 500);
    }

    // 4. Create setup session record (unique constraint on (sessionId, status='in_progress')
    //    means a concurrent race will produce a unique violation — map that to 409)
    const setupId = randomUUID();
    let setupSession: Awaited<ReturnType<typeof deps.setupSessionRepo.insert>>;
    try {
      setupSession = await deps.setupSessionRepo.insert({
        id: setupId,
        sessionId,
        pluginId,
        status: "in_progress",
        startedAt: Date.now(),
      });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("setup_sessions_session_in_progress_uniq") || msg.includes("unique")) {
        return c.json({ error: "Setup already in progress for this session" }, 409);
      }
      throw err;
    }

    // 5. Build and inject system message
    const schemaJson = JSON.stringify(manifest.configSchema, null, 2);
    const systemMessage = [
      `You are now setting up ${npmPackage}.`,
      `Plugin: ${manifest.name} — ${manifest.description}`,
      `ConfigSchema:`,
      "```json",
      schemaJson,
      "```",
      `Use setup.* tools to collect, validate, and save each field.`,
      `When done, call setup.complete().`,
      `If the user cancels, call setup.rollback().`,
    ].join("\n");

    // 5b. Check provider status and append hint
    let providerHint = "";
    if (deps.checkProvider) {
      const providerStatus = await deps.checkProvider(sessionId);
      if (providerStatus.configured) {
        providerHint = `\n\nPROVIDER ALREADY CONFIGURED: ${providerStatus.provider}. Skip the provider question and proceed directly with plugin-specific setup.`;
      } else {
        providerHint = [
          "",
          "",
          "PROVIDER NOT CONFIGURED: Before proceeding with plugin setup, ask the user to choose an AI provider.",
          "Options:",
          "1. BYOK (Anthropic, OpenAI, Google) — user brings their own API key. Validate with setup.validateKey() before saving.",
          '2. WOPR hosted — no key needed, save provider as "wopr-hosted" via setup.saveConfig("provider", "wopr-hosted").',
          "",
          "If the user provides an invalid key, ask again gracefully. After 3 failed attempts, offer hosted as a fallback.",
          "Once provider is set, continue with plugin-specific setup immediately.",
        ].join("\n");
      }
    }

    const fullSystemMessage = systemMessage + providerHint;

    try {
      await deps.onboardingService.inject(sessionId, fullSystemMessage, { from: "system" });
    } catch (err) {
      logger.error("Failed to inject setup context into WOPR session", {
        sessionId,
        pluginId,
        err,
      });
      await deps.setupSessionRepo.markRolledBack(setupId);
      return c.json({ error: `Failed to inject setup context: ${String(err)}` }, 500);
    }

    // 6. Return success — bot's response comes via SSE stream
    return c.json({ ok: true, setupSessionId: setupSession.id });
  });

  // POST /rollback — explicit user cancellation
  routes.post("/rollback", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = sessionIdSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }
    try {
      const result = await deps.setupService.rollback(parsed.data.setupSessionId);
      return c.json({ ok: true, ...result });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("not found")) return c.json({ error: msg }, 404);
      throw err;
    }
  });

  // POST /complete — successful setup completion
  routes.post("/complete", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = sessionIdSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }
    try {
      await deps.setupSessionRepo.markComplete(parsed.data.setupSessionId);
      return c.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("not found")) return c.json({ error: msg }, 404);
      throw err;
    }
  });

  // POST /error — record a setup error (auto-rollback at 3)
  routes.post("/error", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = sessionIdSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }
    let count: number;
    try {
      count = await deps.setupService.recordError(parsed.data.setupSessionId);
    } catch (err) {
      const msg = String(err);
      if (msg.includes("not found")) return c.json({ error: msg }, 404);
      throw err;
    }
    const session = await deps.setupSessionRepo.findById(parsed.data.setupSessionId);
    return c.json({ ok: true, errorCount: count, rolledBack: session?.status === "rolled_back" });
  });

  // GET /resume?sessionId=xxx — check for resumable session
  routes.get("/resume", async (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) return c.json({ error: "sessionId query param required" }, 400);
    const result = await deps.setupService.checkForResumable(sessionId);
    return c.json(result);
  });

  // POST /save — persist validated config, encrypt secrets, inject env vars
  routes.post("/save", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = saveConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const { setupSessionId, botId, values } = parsed.data;

    // 1. Look up setup session
    const session = await deps.setupSessionRepo.findById(setupSessionId);
    if (!session) {
      return c.json({ error: `Setup session not found: ${setupSessionId}` }, 404);
    }
    if (session.status !== "in_progress") {
      return c.json({ error: `Setup session is not in progress (status: ${session.status})` }, 400);
    }

    // 2. Look up plugin manifest for configSchema
    const manifest = deps.pluginRegistry.find((p) => p.id === session.pluginId);
    if (!manifest) {
      return c.json({ error: `Plugin not found: ${session.pluginId}` }, 404);
    }

    // 3. Encrypt secret fields
    if (!deps.platformEncryptionSecret) {
      return c.json({ error: "Platform encryption not configured" }, 503);
    }
    const key = deriveInstanceKey(botId, deps.platformEncryptionSecret);
    const encryptedFields: Record<string, unknown> = {};
    const configValues: Record<string, unknown> = {};

    for (const field of manifest.configSchema) {
      const val = values[field.key];
      if (val === undefined) continue;
      if (field.secret) {
        // Secret fields are stored encrypted only — never in plaintext configJson
        if (typeof val === "string") {
          encryptedFields[field.key] = encrypt(val, key);
        }
      } else {
        configValues[field.key] = val;
      }
    }

    // 4. Verify ownership before persisting anything
    const profile = await deps.profileStore.get(botId);
    if (!profile) {
      return c.json({ error: `Bot not found: ${botId}` }, 404);
    }
    const authenticatedTenantId = c.req.header("x-authenticated-tenant-id");
    if (!authenticatedTenantId) {
      return c.json({ error: "Authentication required" }, 401);
    }
    if (profile.tenantId !== authenticatedTenantId) {
      return c.json({ error: "Bot does not belong to your tenant" }, 403);
    }

    // 5. Upsert into plugin_configs
    await deps.pluginConfigRepo.upsert({
      id: randomUUID(),
      botId,
      pluginId: session.pluginId,
      configJson: JSON.stringify(configValues),
      encryptedFieldsJson: Object.keys(encryptedFields).length > 0 ? JSON.stringify(encryptedFields) : null,
      setupSessionId,
    });

    const envUpdates: Record<string, string> = {};
    for (const field of manifest.configSchema) {
      if (field.env && values[field.key] !== undefined) {
        envUpdates[field.env] = String(values[field.key]);
      }
    }

    if (Object.keys(envUpdates).length > 0) {
      const updatedEnv = { ...profile.env, ...envUpdates };
      await deps.profileStore.save({ ...profile, env: updatedEnv });

      // 6. Dispatch env update for zero-downtime restart
      await deps.dispatchEnvUpdate(botId, profile.tenantId, updatedEnv);
    }

    // 6b. Dispatch plugin install + config to running daemon (non-fatal)
    const npmPackage = manifest.install?.[0];
    let pluginInstallResult: { dispatched: boolean; dispatchError?: string } = {
      dispatched: false,
      dispatchError: "no_npm_package",
    };
    let pluginConfigResult: { dispatched: boolean; dispatchError?: string } = {
      dispatched: false,
      dispatchError: "install_skipped",
    };

    if (npmPackage) {
      pluginInstallResult = await deps.dispatchPluginInstall(botId, npmPackage);

      // Only dispatch config if install succeeded
      if (pluginInstallResult.dispatched && Object.keys(configValues).length > 0) {
        pluginConfigResult = await deps.dispatchPluginConfig(botId, session.pluginId, configValues);
      }
    }

    // 6c. Apply stored configs to dependency plugins (non-fatal)
    let dependencyConfigResults: DependencyConfigResult[] = [];
    if (pluginInstallResult.dispatched) {
      dependencyConfigResults = await applyDependencyConfigs({
        botId,
        superpowerPluginName: session.pluginId,
        pluginRegistry: deps.pluginRegistry,
        fetchDependencies: deps.fetchPluginDependencies,
        dispatchConfig: deps.dispatchPluginConfig,
        findAllForBot: (bId) => deps.pluginConfigRepo.findAllForBot(bId),
      });
      if (dependencyConfigResults.length > 0) {
        logger.info("Dependency config dispatch results", {
          botId,
          pluginId: session.pluginId,
          results: dependencyConfigResults,
        });
      }
    }

    // 7. Update collected on setup session
    await deps.setupSessionRepo.update(setupSessionId, {
      collected: JSON.stringify(configValues),
    });

    // 8. Record success (resets error count)
    await deps.setupService.recordSuccess(setupSessionId);

    logger.info("Saved plugin config via setup", {
      setupSessionId,
      botId,
      pluginId: session.pluginId,
      envKeysInjected: Object.keys(envUpdates),
      pluginInstallDispatched: pluginInstallResult.dispatched,
      pluginConfigDispatched: pluginConfigResult.dispatched,
    });

    return c.json({
      ok: true,
      envKeysInjected: Object.keys(envUpdates),
      pluginInstallDispatched: pluginInstallResult.dispatched,
      pluginConfigDispatched: pluginConfigResult.dispatched,
      dependencyConfigResults,
    });
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Singleton wiring (same pattern as chat.ts)
// ---------------------------------------------------------------------------

let _deps: SetupRouteDeps | null = null;

export function setSetupDeps(deps: SetupRouteDeps): void {
  _deps = deps;
  _setupRoutesInner = null; // Reset so next request uses new deps
}

function getDeps(): SetupRouteDeps {
  if (!_deps) {
    throw new Error("Setup route deps not initialized — call setSetupDeps() before serving requests");
  }
  return _deps;
}

let _setupRoutesInner: Hono | null = null;

function getSetupRoutesInner(): Hono {
  if (!_setupRoutesInner) {
    _setupRoutesInner = createSetupRoutes(getDeps());
  }
  return _setupRoutesInner;
}

const _lazySetupRoutes = new Hono<AuthEnv>();
_lazySetupRoutes.all("/*", async (c) => {
  // Auth must be checked here, in the outer context where resolveSessionUser()
  // has already populated c.get("user"). inner.fetch(c.req.raw) creates a
  // fresh Hono context with no user set, so getUser() inside the inner
  // handlers would always return null in production.
  const user = getUser(c);
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }
  // Forward authenticated identity to inner routes via headers.
  // inner.fetch() creates a fresh Hono context that loses c.get("user").
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-authenticated-user-id", user.id);
  // tenantId: from tokenTenantId (API key auth) or user.id (session = personal tenant)
  const tenantId = c.get("tokenTenantId") ?? user.id;
  headers.set("x-authenticated-tenant-id", tenantId);
  const req = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers,
    body: c.req.raw.body,
    duplex: "half",
  } as RequestInit);
  const inner = getSetupRoutesInner();
  return inner.fetch(req);
});

export const setupRoutes = new Hono();
setupRoutes.route("/", _lazySetupRoutes);
