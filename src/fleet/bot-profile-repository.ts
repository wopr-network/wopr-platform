import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema/index.js";
import { botProfiles } from "../db/schema/index.js";
import type { BotProfile } from "./types.js";

/**
 * Repository interface for bot profiles.
 * Replaces the YAML-based ProfileStore.
 */
export interface IBotProfileRepository {
  get(id: string): BotProfile | null;
  save(profile: BotProfile): BotProfile; // upsert
  delete(id: string): boolean;
  list(): BotProfile[];
}

/**
 * Drizzle-backed implementation of IBotProfileRepository.
 * Stores bot profiles in the `bot_profiles` SQLite table.
 */
export class DrizzleBotProfileRepository implements IBotProfileRepository {
  constructor(private readonly db: BetterSQLite3Database<typeof schema>) {}

  get(id: string): BotProfile | null {
    const row = this.db.select().from(botProfiles).where(eq(botProfiles.id, id)).get();
    return row ? toProfile(row) : null;
  }

  save(profile: BotProfile): BotProfile {
    this.db
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
        },
      })
      .run();
    return profile;
  }

  delete(id: string): boolean {
    const result = this.db.delete(botProfiles).where(eq(botProfiles.id, id)).run();
    return result.changes > 0;
  }

  list(): BotProfile[] {
    const rows = this.db.select().from(botProfiles).all();
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
    env: JSON.parse(row.env) as Record<string, string>,
    restartPolicy: row.restartPolicy as BotProfile["restartPolicy"],
    updatePolicy: row.updatePolicy as BotProfile["updatePolicy"],
    volumeName: row.volumeName ?? undefined,
    description: row.description,
    releaseChannel: (row.releaseChannel ?? "stable") as BotProfile["releaseChannel"],
    discovery: row.discoveryJson ? JSON.parse(row.discoveryJson) : undefined,
  };
}
