import Docker from "dockerode";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { logger } from "../../config/logger.js";
import { BotNotFoundError, FleetManager } from "../../fleet/fleet-manager.js";
import { defaultTemplatesDir, loadProfileTemplates } from "../../fleet/profile-loader.js";
import type { ProfileTemplate } from "../../fleet/profile-schema.js";
import { ProfileStore } from "../../fleet/profile-store.js";
import { createBotSchema, updateBotSchema } from "../../fleet/types.js";

const DATA_DIR = process.env.FLEET_DATA_DIR || "/data/fleet";
const FLEET_API_TOKEN = process.env.FLEET_API_TOKEN;

const docker = new Docker();
const store = new ProfileStore(DATA_DIR);
const fleet = new FleetManager(docker, store);

export const fleetRoutes = new Hono();

// CRITICAL: Require bearer token authentication on all fleet routes
if (!FLEET_API_TOKEN) {
  logger.warn("FLEET_API_TOKEN is not set — fleet routes will reject all requests");
}
fleetRoutes.use("/*", bearerAuth({ token: FLEET_API_TOKEN || "" }));

/** GET /fleet/bots — List all bots with live status */
fleetRoutes.get("/bots", async (c) => {
  const bots = await fleet.listAll();
  return c.json({ bots });
});

/** POST /fleet/bots — Create a new bot from profile config */
fleetRoutes.post("/bots", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createBotSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  try {
    const profile = await fleet.create(parsed.data);
    return c.json(profile, 201);
  } catch (err) {
    logger.error("Failed to create bot", { err });
    return c.json({ error: "Failed to create bot" }, 500);
  }
});

/** GET /fleet/bots/:id — Get bot details + health */
fleetRoutes.get("/bots/:id", async (c) => {
  try {
    const status = await fleet.status(c.req.param("id"));
    return c.json(status);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** PATCH /fleet/bots/:id — Update bot config (triggers restart if running) */
fleetRoutes.patch("/bots/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = updateBotSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  }

  // Reject empty updates
  if (Object.keys(parsed.data).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  try {
    const profile = await fleet.update(c.req.param("id"), parsed.data);
    return c.json(profile);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** DELETE /fleet/bots/:id — Stop and remove bot */
fleetRoutes.delete("/bots/:id", async (c) => {
  try {
    await fleet.remove(c.req.param("id"), c.req.query("removeVolumes") === "true");
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/start — Start a stopped bot */
fleetRoutes.post("/bots/:id/start", async (c) => {
  try {
    await fleet.start(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/stop — Stop a running bot */
fleetRoutes.post("/bots/:id/stop", async (c) => {
  try {
    await fleet.stop(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** POST /fleet/bots/:id/restart — Restart a running bot */
fleetRoutes.post("/bots/:id/restart", async (c) => {
  try {
    await fleet.restart(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** GET /fleet/bots/:id/logs — Tail bot container logs */
fleetRoutes.get("/bots/:id/logs", async (c) => {
  const raw = c.req.query("tail");
  const parsed = raw != null ? Number.parseInt(raw, 10) : 100;
  const tail = Number.isNaN(parsed) || parsed < 1 ? 100 : Math.min(parsed, 10_000);
  try {
    const logs = await fleet.logs(c.req.param("id"), tail);
    return c.text(logs);
  } catch (err) {
    if (err instanceof BotNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

/** In-memory set of bot names that have been seeded (placeholder until fleet manager provides real storage) */
const seededBots = new Set<string>();

export interface SeedResult {
  created: string[];
  skipped: string[];
}

/**
 * Seed bots from profile templates.
 * @param templates - Parsed profile templates to seed from.
 * @param existingNames - Set of bot names that already exist (mutated in place).
 */
export function seedBots(templates: ProfileTemplate[], existingNames: Set<string>): SeedResult {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const template of templates) {
    if (existingNames.has(template.name)) {
      skipped.push(template.name);
    } else {
      existingNames.add(template.name);
      created.push(template.name);
    }
  }

  return { created, skipped };
}

fleetRoutes.post("/seed", (c) => {
  const templatesDir = defaultTemplatesDir();

  let templates: ProfileTemplate[];
  try {
    templates = loadProfileTemplates(templatesDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load templates";
    return c.json({ error: message }, 500);
  }

  if (templates.length === 0) {
    return c.json({ error: "No templates found" }, 404);
  }

  const result = seedBots(templates, seededBots);
  return c.json(result, 200);
});

/** Export fleet manager for testing */
export { fleet, FleetManager };
