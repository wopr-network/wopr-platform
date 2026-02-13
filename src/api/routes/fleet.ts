import { Hono } from "hono";
import { defaultTemplatesDir, loadProfileTemplates } from "../../fleet/profile-loader.js";
import type { ProfileTemplate } from "../../fleet/profile-schema.js";

export const fleetRoutes = new Hono();

// Placeholder — WOP-220 will implement Fleet Manager with Docker API integration
fleetRoutes.get("/", (c) => {
  return c.json({ bots: [] });
});

/** In-memory set of bot names that have been seeded (placeholder until WOP-220 provides real storage) */
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
