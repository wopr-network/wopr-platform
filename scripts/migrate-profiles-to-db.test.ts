import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema/index.js";
import { migrateProfilesToDb } from "./migrate-profiles-to-db.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bot_profiles (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      image TEXT NOT NULL,
      env TEXT NOT NULL DEFAULT '{}',
      restart_policy TEXT NOT NULL DEFAULT 'unless-stopped',
      update_policy TEXT NOT NULL DEFAULT 'on-push',
      release_channel TEXT NOT NULL DEFAULT 'stable',
      volume_name TEXT,
      discovery_json TEXT,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bot_profiles_tenant ON bot_profiles (tenant_id);
    CREATE INDEX IF NOT EXISTS idx_bot_profiles_name ON bot_profiles (tenant_id, name);
    CREATE INDEX IF NOT EXISTS idx_bot_profiles_release_channel ON bot_profiles (release_channel);
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

const TEST_DIR = join(process.cwd(), "test-data-migrate-profiles");
const TEST_IMAGE = "ghcr.io/wopr-network/test:latest";

// Valid RFC 4122 UUIDs (version 4, variant bits set correctly)
const UUID_1 = "a0a0a0a0-b0b0-4c0c-8d0d-e0e0e0e0e0e0";
const UUID_2 = "11111111-2222-4333-8444-555555555555";
const UUID_3 = "22222222-3333-4444-8555-666666666666";
const UUID_4 = "33333333-4444-4555-8666-777777777777";
const UUID_5 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

describe("migrateProfilesToDb", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    const testDb = createTestDb();
    sqlite = testDb.sqlite;
    db = testDb.db;
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    sqlite.close();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("migrates YAML profiles to the database", async () => {
    const profile = {
      id: UUID_1,
      tenantId: "tenant-1",
      name: "test-bot",
      description: "A test bot",
      image: TEST_IMAGE,
      env: { TOKEN: "secret123" },
      restartPolicy: "unless-stopped",
      releaseChannel: "stable",
      updatePolicy: "manual",
    };
    await writeFile(
      join(TEST_DIR, `${profile.id}.yaml`),
      yaml.dump(profile, { sortKeys: true }),
      "utf-8",
    );

    const result = await migrateProfilesToDb(TEST_DIR, db);

    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);

    const row = sqlite
      .prepare("SELECT * FROM bot_profiles WHERE id = ?")
      .get(profile.id) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.name).toBe("test-bot");
    expect(row.tenant_id).toBe("tenant-1");
    expect(JSON.parse(row.env as string)).toEqual({ TOKEN: "secret123" });
  });

  it("skips invalid YAML files gracefully", async () => {
    await writeFile(join(TEST_DIR, "not-a-uuid.yaml"), "garbage: true\n", "utf-8");

    const result = await migrateProfilesToDb(TEST_DIR, db);

    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("handles empty data directory", async () => {
    const result = await migrateProfilesToDb(TEST_DIR, db);

    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("is idempotent — running twice does not error", async () => {
    const profile = {
      id: UUID_2,
      tenantId: "tenant-2",
      name: "idempotent-bot",
      description: "",
      image: TEST_IMAGE,
      env: {},
      restartPolicy: "always",
      releaseChannel: "canary",
      updatePolicy: "on-push",
    };
    await writeFile(
      join(TEST_DIR, `${profile.id}.yaml`),
      yaml.dump(profile, { sortKeys: true }),
      "utf-8",
    );

    const first = await migrateProfilesToDb(TEST_DIR, db);
    const second = await migrateProfilesToDb(TEST_DIR, db);

    expect(first.migrated).toBe(1);
    expect(second.migrated).toBe(1); // upsert succeeds again
    expect(second.errors).toEqual([]);

    const rows = sqlite.prepare("SELECT COUNT(*) as count FROM bot_profiles").get() as { count: number };
    expect(rows.count).toBe(1); // still only one row
  });

  it("migrates multiple profiles", async () => {
    const uuids = [UUID_3, UUID_4, UUID_5];
    for (let i = 0; i < 3; i++) {
      const profile = {
        id: uuids[i],
        tenantId: `tenant-${i + 1}`,
        name: `bot-${i + 1}`,
        description: "",
        image: TEST_IMAGE,
        env: {},
        restartPolicy: "unless-stopped",
        releaseChannel: "stable",
        updatePolicy: "manual",
      };
      await writeFile(
        join(TEST_DIR, `${profile.id}.yaml`),
        yaml.dump(profile, { sortKeys: true }),
        "utf-8",
      );
    }

    const result = await migrateProfilesToDb(TEST_DIR, db);

    expect(result.migrated).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("reports per-profile errors without aborting", async () => {
    // Write a valid profile
    const good = {
      id: UUID_1,
      tenantId: "tenant-1",
      name: "good-bot",
      description: "",
      image: TEST_IMAGE,
      env: {},
      restartPolicy: "unless-stopped",
      releaseChannel: "stable",
      updatePolicy: "manual",
    };
    await writeFile(
      join(TEST_DIR, `${good.id}.yaml`),
      yaml.dump(good, { sortKeys: true }),
      "utf-8",
    );
    // Write a file that parses as YAML but has an invalid image (will fail BotProfile validation in ProfileStore.list())
    // ProfileStore.list() uses safeParse and skips invalid — so this becomes a "skipped" profile
    await writeFile(
      join(TEST_DIR, `${UUID_5}.yaml`),
      yaml.dump({
        id: UUID_5,
        tenantId: "t",
        name: "bad",
        image: "invalid-registry/bad:latest",
        env: {},
        restartPolicy: "unless-stopped",
        releaseChannel: "stable",
        updatePolicy: "manual",
      }, { sortKeys: true }),
      "utf-8",
    );

    const result = await migrateProfilesToDb(TEST_DIR, db);

    // ProfileStore.list() skips invalid profiles via safeParse, so only 1 migrated
    expect(result.migrated).toBe(1);
  });
});
