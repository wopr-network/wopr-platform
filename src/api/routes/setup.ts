import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../../config/logger.js";
import type { OnboardingService } from "../../onboarding/onboarding-service.js";
import type { ProviderStatus } from "../../onboarding/provider-check.js";
import { deriveInstanceKey, encrypt } from "../../security/encryption.js";
import type { IPluginConfigRepository } from "../../setup/plugin-config-repository.js";
import type { SetupService } from "../../setup/setup-service.js";
import type { ISetupSessionRepository } from "../../setup/setup-session-repository.js";
import type { PluginManifest } from "./marketplace-registry.js";

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
      configValues[field.key] = val;
      if (field.secret && typeof val === "string") {
        encryptedFields[field.key] = encrypt(val, key);
      }
    }

    // 4. Upsert into plugin_configs
    await deps.pluginConfigRepo.upsert({
      id: randomUUID(),
      botId,
      pluginId: session.pluginId,
      configJson: JSON.stringify(configValues),
      encryptedFieldsJson: Object.keys(encryptedFields).length > 0 ? JSON.stringify(encryptedFields) : null,
      setupSessionId,
    });

    // 5. Inject env vars into bot profile
    const profile = await deps.profileStore.get(botId);
    if (!profile) {
      return c.json({ error: `Bot not found: ${botId}` }, 404);
    }

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
    });

    return c.json({ ok: true, envKeysInjected: Object.keys(envUpdates) });
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

const _lazySetupRoutes = new Hono();
_lazySetupRoutes.all("/*", async (c) => {
  const inner = getSetupRoutesInner();
  return inner.fetch(c.req.raw);
});

export const setupRoutes = new Hono();
setupRoutes.route("/", _lazySetupRoutes);
