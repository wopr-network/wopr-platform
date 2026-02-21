/**
 * One-time migration script: YAML bot profiles → bot_profiles DB table.
 *
 * Usage:
 *   PLATFORM_DB_PATH=/data/platform/platform.db \
 *   FLEET_DATA_DIR=/data/fleet \
 *   npx tsx scripts/migrate-profiles-to-db.ts
 *
 * Safe to re-run — uses upsert (ON CONFLICT DO UPDATE).
 */

import { readdir } from "node:fs/promises";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { applyPlatformPragmas } from "../src/db/pragmas.js";
import * as schema from "../src/db/schema/index.js";
import { botProfiles } from "../src/db/schema/index.js";
import { ProfileStore } from "../src/fleet/profile-store.js";

export interface MigrationResult {
  migrated: number;
  skipped: number;
  errors: Array<{ profileId: string; error: string }>;
}

/**
 * Migrate all YAML bot profiles from `dataDir` into the `bot_profiles` table.
 *
 * Exported for testing. When run as a script, `main()` calls this with
 * env-configured paths.
 */
export async function migrateProfilesToDb(
  dataDir: string,
  db: BetterSQLite3Database<typeof schema>,
): Promise<MigrationResult> {
  // Verify bot_profiles table exists — fail fast with clear error if not
  try {
    db.run(sql`SELECT 1 FROM bot_profiles LIMIT 0`);
  } catch (err) {
    throw new Error(
      `bot_profiles table does not exist. Run db:migrate before the migration script. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const store = new ProfileStore(dataDir);
  const profiles = await store.list();

  const result: MigrationResult = { migrated: 0, skipped: 0, errors: [] };

  // Count YAML files to detect skipped (profiles that failed safeParse)
  const files = await readdir(dataDir).catch(() => [] as string[]);
  const yamlFileCount = files.filter((f) => f.endsWith(".yaml")).length;

  for (const profile of profiles) {
    try {
      db.insert(botProfiles)
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
            updatedAt: sql`(datetime('now'))`,
          },
        })
        .run();
      result.migrated++;
      console.log(`  [OK] ${profile.id} (${profile.name})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ profileId: profile.id, error: msg });
      console.error(`  [ERR] ${profile.id}: ${msg}`);
    }
  }

  result.skipped = yamlFileCount - profiles.length;
  if (result.skipped > 0) {
    console.log(`  [SKIP] ${result.skipped} YAML file(s) failed validation and were skipped`);
  }

  return result;
}

/**
 * CLI entry point — only runs when executed directly (not when imported in tests).
 */
async function main() {
  const dbPath = process.env.PLATFORM_DB_PATH ?? "/data/platform/platform.db";
  const dataDir = process.env.FLEET_DATA_DIR ?? "/data/fleet";

  console.log("Migration: YAML profiles → bot_profiles DB");
  console.log(`  DB:   ${dbPath}`);
  console.log(`  YAML: ${dataDir}`);
  console.log();

  const sqlite = new Database(dbPath);
  applyPlatformPragmas(sqlite);
  const db = drizzle(sqlite, { schema });

  try {
    const result = await migrateProfilesToDb(dataDir, db);
    console.log();
    console.log(
      `Done: ${result.migrated} migrated, ${result.skipped} skipped, ${result.errors.length} errors`,
    );
    if (result.errors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    sqlite.close();
  }
}

// Run main() only when executed directly via `npx tsx`
const isDirectRun = process.argv[1]?.endsWith("migrate-profiles-to-db.ts");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
