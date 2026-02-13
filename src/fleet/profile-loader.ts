import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { type ProfileTemplate, profileTemplateSchema } from "./profile-schema.js";

/** Load and validate a single YAML profile template */
export function parseProfileTemplate(content: string, filename: string): ProfileTemplate {
  const raw = parseYaml(content);
  const result = profileTemplateSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid profile template "${filename}": ${result.error.message}`);
  }
  return result.data;
}

/** Load all profile templates from a directory */
export function loadProfileTemplates(templatesDir: string): ProfileTemplate[] {
  if (!fs.existsSync(templatesDir)) {
    return [];
  }

  const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const templates: ProfileTemplate[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(templatesDir, file), "utf-8");
    templates.push(parseProfileTemplate(content, file));
  }

  return templates;
}

/** Resolve the default templates directory (relative to project root) */
export function defaultTemplatesDir(): string {
  // In production, templates are bundled alongside the dist output.
  // The repo layout puts them at <root>/templates/.
  // __dirname at runtime is dist/fleet/, so we go up two levels.
  return path.resolve(import.meta.dirname, "..", "..", "templates");
}
