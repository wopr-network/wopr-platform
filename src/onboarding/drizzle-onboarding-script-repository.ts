import { randomUUID } from "node:crypto";
import { desc, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { onboardingScripts } from "../db/schema/index.js";
import type { NewOnboardingScript, OnboardingScript } from "./repository-types.js";

export interface IOnboardingScriptRepository {
  findCurrent(): Promise<OnboardingScript | undefined>;
  findHistory(limit: number): Promise<OnboardingScript[]>;
  insert(script: NewOnboardingScript): Promise<OnboardingScript>;
}

type DbRow = typeof onboardingScripts.$inferSelect;

function toScript(row: DbRow): OnboardingScript {
  return {
    id: row.id,
    content: row.content,
    version: row.version,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export class DrizzleOnboardingScriptRepository implements IOnboardingScriptRepository {
  constructor(private readonly db: DrizzleDb) {}

  async findCurrent(): Promise<OnboardingScript | undefined> {
    const rows = await this.db.select().from(onboardingScripts).orderBy(desc(onboardingScripts.version)).limit(1);
    return rows[0] ? toScript(rows[0]) : undefined;
  }

  async findHistory(limit: number): Promise<OnboardingScript[]> {
    const rows = await this.db.select().from(onboardingScripts).orderBy(desc(onboardingScripts.version)).limit(limit);
    return rows.map(toScript);
  }

  async insert(script: NewOnboardingScript): Promise<OnboardingScript> {
    const id = randomUUID();
    const now = Date.now();

    const rows = await this.db
      .insert(onboardingScripts)
      .values({
        id,
        content: script.content,
        version: sql`(SELECT COALESCE(MAX(${onboardingScripts.version}), 0) + 1 FROM ${onboardingScripts})`,
        updatedAt: now,
        updatedBy: script.updatedBy ?? null,
      })
      .returning();

    return toScript(rows[0]);
  }
}
