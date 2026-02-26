import { eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { botProfiles } from "../db/schema/index.js";
import type { IBotProfileRepository } from "./bot-profile-repository.js";
import type { BotProfile } from "./types.js";

/**
 * Drizzle-backed implementation of IBotProfileRepository.
 * Stores bot profiles in the `bot_profiles` table.
 */
export class DrizzleBotProfileRepository implements IBotProfileRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(id: string): Promise<BotProfile | null> {
    const rows = await this.db.select().from(botProfiles).where(eq(botProfiles.id, id));
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async save(profile: BotProfile): Promise<BotProfile> {
    await this.db
      .insert(botProfiles)
      .values({
        id: profile.id,
        tenantId: profile.tenantId,
        name: profile.name,
        image: profile.image,
        env: JSON.stringify(profile.env),
        restartPolicy: profile.restartPolicy,
        updatePolicy: profile.updatePolicy,
        volumeName: profile.volumeName ?? null,
        description: profile.description ?? "",
        releaseChannel: profile.releaseChannel ?? "stable",
        discoveryJson: profile.discovery ? JSON.stringify(profile.discovery) : null,
      })
      .onConflictDoUpdate({
        target: botProfiles.id,
        set: {
          tenantId: profile.tenantId,
          name: profile.name,
          image: profile.image,
          env: JSON.stringify(profile.env),
          restartPolicy: profile.restartPolicy,
          updatePolicy: profile.updatePolicy,
          volumeName: profile.volumeName ?? null,
          description: profile.description ?? "",
          releaseChannel: profile.releaseChannel ?? "stable",
          discoveryJson: profile.discovery ? JSON.stringify(profile.discovery) : null,
          updatedAt: sql`(now())`,
        },
      });
    return profile;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(botProfiles).where(eq(botProfiles.id, id)).returning({ id: botProfiles.id });
    return result.length > 0;
  }

  async list(): Promise<BotProfile[]> {
    const rows = await this.db.select().from(botProfiles);
    return rows.map(toProfile);
  }
}

/** Convert a DB row to a BotProfile domain object. */
function toProfile(row: typeof botProfiles.$inferSelect): BotProfile {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    image: row.image,
    env: (() => {
      try {
        return JSON.parse(row.env) as Record<string, string>;
      } catch {
        return {};
      }
    })(),
    restartPolicy: row.restartPolicy as BotProfile["restartPolicy"],
    updatePolicy: row.updatePolicy as BotProfile["updatePolicy"],
    volumeName: row.volumeName ?? undefined,
    description: row.description,
    releaseChannel: (row.releaseChannel ?? "stable") as BotProfile["releaseChannel"],
    discovery: (() => {
      if (!row.discoveryJson) return undefined;
      try {
        return JSON.parse(row.discoveryJson);
      } catch {
        return null;
      }
    })(),
  };
}
