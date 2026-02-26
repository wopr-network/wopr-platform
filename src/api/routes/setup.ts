import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../../config/logger.js";
import type { OnboardingService } from "../../onboarding/onboarding-service.js";
import type { ISetupSessionRepository } from "../../setup/setup-session-repository.js";
import type { PluginManifest } from "./marketplace-registry.js";

const setupRequestSchema = z.object({
  sessionId: z.string().min(1),
  pluginId: z.string().min(1),
});

export interface SetupRouteDeps {
  pluginRegistry: PluginManifest[];
  setupSessionRepo: ISetupSessionRepository;
  onboardingService: Pick<OnboardingService, "inject">;
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

    try {
      await deps.onboardingService.inject(sessionId, systemMessage, { from: "system" });
    } catch (err) {
      logger.error("Failed to inject setup context into WOPR session", { sessionId, pluginId, err });
      await deps.setupSessionRepo.markRolledBack(setupId);
      return c.json({ error: `Failed to inject setup context: ${String(err)}` }, 500);
    }

    // 6. Return success — bot's response comes via SSE stream
    return c.json({ ok: true, setupSessionId: setupSession.id });
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
