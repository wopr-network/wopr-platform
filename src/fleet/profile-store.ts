import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { botProfileSchema, type BotProfile } from "./types.js";

/**
 * Persists bot profiles as YAML files in a data directory.
 */
export class ProfileStore {
  constructor(private readonly dataDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }

  private filePath(id: string): string {
    return join(this.dataDir, `${id}.yaml`);
  }

  async save(profile: BotProfile): Promise<void> {
    await this.init();
    const content = yaml.dump(profile, { sortKeys: true });
    await writeFile(this.filePath(profile.id), content, "utf-8");
  }

  async get(id: string): Promise<BotProfile | null> {
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      const raw = yaml.load(content, { schema: yaml.JSON_SCHEMA });
      return botProfileSchema.parse(raw);
    } catch {
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
    try {
      await rm(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }
}
