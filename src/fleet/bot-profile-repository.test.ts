import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzleBotProfileRepository } from "./drizzle-bot-profile-repository.js";
import type { BotProfile } from "./types.js";

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
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: DrizzleBotProfileRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzleBotProfileRepository(db);
  });

  describe("get()", () => {
    it("returns null when not found", async () => {
      const result = await repo.get("nonexistent-id");
      expect(result).toBeNull();
    });

    it("returns parsed profile with env as object (not string)", async () => {
      const profile = makeProfile();
      await repo.save(profile);
      const result = await repo.get(profile.id);
      expect(result).not.toBeNull();
      expect(result?.env).toEqual({ FOO: "bar", BAZ: "qux" });
      expect(typeof result?.env).toBe("object");
      expect(typeof result?.env).not.toBe("string");
    });

    it("returns profile with all fields matching", async () => {
      const profile = makeProfile({
        volumeName: "my-volume",
        discovery: { enabled: true, topics: ["wopr-org-test"] },
      });
      await repo.save(profile);
      const result = await repo.get(profile.id);
      expect(result).toEqual(profile);
    });

    it("returns profile with optional fields as undefined when not set", async () => {
      const profile = makeProfile(); // no volumeName, no discovery
      await repo.save(profile);
      const result = await repo.get(profile.id);
      expect(result?.volumeName).toBeUndefined();
      expect(result?.discovery).toBeUndefined();
    });
  });

  describe("save()", () => {
    it("inserts a new profile", async () => {
      const profile = makeProfile();
      const result = await repo.save(profile);
      expect(result).toEqual(profile);
      expect(await repo.get(profile.id)).toEqual(profile);
    });

    it("upserts an existing profile (updates on conflict)", async () => {
      const profile = makeProfile();
      await repo.save(profile);

      const updated = { ...profile, name: "updated-bot", image: TEST_IMAGE };
      await repo.save(updated);

      const result = await repo.get(profile.id);
      expect(result?.name).toBe("updated-bot");
    });

    it("handles empty env object", async () => {
      const profile = makeProfile({ env: {} });
      await repo.save(profile);
      const result = await repo.get(profile.id);
      expect(result?.env).toEqual({});
    });

    it("preserves discovery config through round-trip", async () => {
      const profile = makeProfile({
        discovery: { enabled: false, topics: ["topic-a", "topic-b"] },
      });
      await repo.save(profile);
      const result = await repo.get(profile.id);
      expect(result?.discovery).toEqual({ enabled: false, topics: ["topic-a", "topic-b"] });
    });
  });

  describe("delete()", () => {
    it("returns true when profile exists and is deleted", async () => {
      const profile = makeProfile();
      await repo.save(profile);
      expect(await repo.delete(profile.id)).toBe(true);
      expect(await repo.get(profile.id)).toBeNull();
    });

    it("returns false when profile does not exist", async () => {
      expect(await repo.delete("nonexistent-id")).toBe(false);
    });
  });

  describe("list()", () => {
    it("returns empty array when no profiles", async () => {
      expect(await repo.list()).toEqual([]);
    });

    it("returns all saved profiles", async () => {
      const p1 = makeProfile({ id: "aaaaaaaa-1111-1111-1111-111111111111", name: "bot-1" });
      const p2 = makeProfile({
        id: "bbbbbbbb-2222-2222-2222-222222222222",
        name: "bot-2",
        tenantId: "tenant-2",
      });
      await repo.save(p1);
      await repo.save(p2);

      const result = await repo.list();
      expect(result).toHaveLength(2);
      expect(result.map((p) => p.name).sort()).toEqual(["bot-1", "bot-2"]);
    });

    it("returns profiles with env parsed as objects", async () => {
      const p = makeProfile({ env: { KEY: "value" } });
      await repo.save(p);
      const [result] = await repo.list();
      expect(typeof result.env).toBe("object");
      expect(result.env).toEqual({ KEY: "value" });
    });
  });
});
