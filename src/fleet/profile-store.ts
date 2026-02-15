import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import yaml from "js-yaml";
import { type BotProfile, botProfileSchema } from "./types.js";

/**
 * Persists bot profiles as YAML files in a data directory.
 */
export class ProfileStore {
  constructor(private readonly dataDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }

  private safePath(id: string): string {
    // UUID validation - primary defense
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) {
      throw new Error(`Invalid profile ID: must be a UUID (got: ${id})`);
    }

    // Path resolution - safety net against traversal
    const resolved = resolve(this.dataDir, `${id}.yaml`);
    const baseDir = resolve(this.dataDir);
    if (!resolved.startsWith(`${baseDir}${sep}`) && resolved !== baseDir) {
      throw new Error(`Path traversal detected: ${id}`);
    }

    return resolved;
  }

  async save(profile: BotProfile): Promise<void> {
    await this.init();
    const content = yaml.dump(profile, { sortKeys: true });
    await writeFile(this.safePath(profile.id), content, "utf-8");
  }

  async get(id: string): Promise<BotProfile | null> {
    const filePath = this.safePath(id); // Validate ID first - throws on invalid
    try {
      const content = await readFile(filePath, "utf-8");
      const raw = yaml.load(content, { schema: yaml.JSON_SCHEMA });
      return botProfileSchema.parse(raw);
    } catch {
      // Only catch file system errors (file not found, permission denied, etc.)
      // safePath() validation errors propagate before try block
      return null;
    }
  }

  async list(): Promise<BotProfile[]> {
    await this.init();
    const files = await readdir(this.dataDir);
    const profiles: BotProfile[] = [];
    for (const file of files) {
      if (!file.endsWith(".yaml")) continue;
      const content = await readFile(join(this.dataDir, file), "utf-8");
      const raw = yaml.load(content, { schema: yaml.JSON_SCHEMA });
      const parsed = botProfileSchema.safeParse(raw);
      if (parsed.success) {
        profiles.push(parsed.data);
      }
    }
    return profiles;
  }

  async delete(id: string): Promise<boolean> {
    const filePath = this.safePath(id); // Validate ID first - throws on invalid
    try {
      await rm(filePath);
      return true;
    } catch {
      // Only catch file system errors
      // safePath() validation errors propagate before try block
      return false;
    }
  }
}
