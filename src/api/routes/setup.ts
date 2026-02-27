import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../../config/logger.js";
import type { OnboardingService } from "../../onboarding/onboarding-service.js";
import type { ProviderStatus } from "../../onboarding/provider-check.js";
import type { SetupService } from "../../setup/setup-service.js";
import type { ISetupSessionRepository } from "../../setup/setup-session-repository.js";
import type { PluginManifest } from "./marketplace-registry.js";

const setupRequestSchema = z.object({
  sessionId: z.string().min(1),
  pluginId: z.string().min(1),
});

const sessionIdSchema = z.object({ setupSessionId: z.string().min(1) });

export interface SetupRouteDeps {
  pluginRegistry: PluginManifest[];
  setupSessionRepo: ISetupSessionRepository;
  onboardingService: Pick<OnboardingService, "inject">;
  setupService: SetupService;
  checkProvider?: (sessionId: string) => Promise<ProviderStatus>;
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
