import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { DrizzleBotProfileRepository } from "./drizzle-bot-profile-repository.js";
import type { BotProfile } from "./types.js";

function makeDb() {
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
  return drizzle(sqlite, { schema });
}

const TEST_IMAGE = "ghcr.io/wopr-network/test:latest";

function makeProfile(overrides: Partial<BotProfile> = {}): BotProfile {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    tenantId: "tenant-1",
    name: "test-bot",
    description: "A test bot",
    image: TEST_IMAGE,
    env: { FOO: "bar", BAZ: "qux" },
    restartPolicy: "unless-stopped",
    releaseChannel: "stable",
    updatePolicy: "manual",
    ...overrides,
  };
}

describe("DrizzleBotProfileRepository", () => {
  let repo: DrizzleBotProfileRepository;

  beforeEach(() => {
    repo = new DrizzleBotProfileRepository(makeDb());
  });

  describe("get()", () => {
    it("returns null when not found", () => {
      const result = repo.get("nonexistent-id");
      expect(result).toBeNull();
    });

    it("returns parsed profile with env as object (not string)", () => {
      const profile = makeProfile();
      repo.save(profile);
      const result = repo.get(profile.id);
      expect(result).not.toBeNull();
      expect(result?.env).toEqual({ FOO: "bar", BAZ: "qux" });
      expect(typeof result?.env).toBe("object");
      expect(typeof result?.env).not.toBe("string");
    });

    it("returns profile with all fields matching", () => {
      const profile = makeProfile({
        volumeName: "my-volume",
        discovery: { enabled: true, topics: ["wopr-org-test"] },
      });
      repo.save(profile);
      const result = repo.get(profile.id);
      expect(result).toEqual(profile);
    });

    it("returns profile with optional fields as undefined when not set", () => {
      const profile = makeProfile(); // no volumeName, no discovery
      repo.save(profile);
      const result = repo.get(profile.id);
      expect(result?.volumeName).toBeUndefined();
      expect(result?.discovery).toBeUndefined();
    });
  });

  describe("save()", () => {
    it("inserts a new profile", () => {
      const profile = makeProfile();
      const result = repo.save(profile);
      expect(result).toEqual(profile);
      expect(repo.get(profile.id)).toEqual(profile);
    });

    it("upserts an existing profile (updates on conflict)", () => {
      const profile = makeProfile();
      repo.save(profile);

      const updated = { ...profile, name: "updated-bot", image: TEST_IMAGE };
      repo.save(updated);

      const result = repo.get(profile.id);
      expect(result?.name).toBe("updated-bot");
    });

    it("handles empty env object", () => {
      const profile = makeProfile({ env: {} });
      repo.save(profile);
      const result = repo.get(profile.id);
      expect(result?.env).toEqual({});
    });

    it("preserves discovery config through round-trip", () => {
      const profile = makeProfile({
        discovery: { enabled: false, topics: ["topic-a", "topic-b"] },
      });
      repo.save(profile);
      const result = repo.get(profile.id);
      expect(result?.discovery).toEqual({ enabled: false, topics: ["topic-a", "topic-b"] });
    });
  });

  describe("delete()", () => {
    it("returns true when profile exists and is deleted", () => {
      const profile = makeProfile();
      repo.save(profile);
      expect(repo.delete(profile.id)).toBe(true);
      expect(repo.get(profile.id)).toBeNull();
    });

    it("returns false when profile does not exist", () => {
      expect(repo.delete("nonexistent-id")).toBe(false);
    });
  });

  describe("list()", () => {
    it("returns empty array when no profiles", () => {
      expect(repo.list()).toEqual([]);
    });

    it("returns all saved profiles", () => {
      const p1 = makeProfile({ id: "aaaaaaaa-1111-1111-1111-111111111111", name: "bot-1" });
      const p2 = makeProfile({
        id: "bbbbbbbb-2222-2222-2222-222222222222",
        name: "bot-2",
        tenantId: "tenant-2",
      });
      repo.save(p1);
      repo.save(p2);

      const result = repo.list();
      expect(result).toHaveLength(2);
      expect(result.map((p) => p.name).sort()).toEqual(["bot-1", "bot-2"]);
    });

    it("returns profiles with env parsed as objects", () => {
      const p = makeProfile({ env: { KEY: "value" } });
      repo.save(p);
      const [result] = repo.list();
      expect(typeof result.env).toBe("object");
      expect(result.env).toEqual({ KEY: "value" });
    });
  });
});
