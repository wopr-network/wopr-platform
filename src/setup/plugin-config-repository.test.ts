import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, truncateAllTables } from "../test/db.js";
import { DrizzlePluginConfigRepository, type IPluginConfigRepository } from "./plugin-config-repository.js";

describe("DrizzlePluginConfigRepository", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let repo: IPluginConfigRepository;

  beforeAll(async () => {
    ({ db, pool } = await createTestDb());
  });

  afterAll(async () => {
    await pool.close();
  });

  beforeEach(async () => {
    await truncateAllTables(pool);
    repo = new DrizzlePluginConfigRepository(db);
  });

  it("upserts and retrieves a plugin config", async () => {
    const botId = randomUUID();
    const pluginId = "discord-channel";
    const config = {
      id: randomUUID(),
      botId,
      pluginId,
      configJson: JSON.stringify({ botToken: "MTxxx" }),
      encryptedFieldsJson: JSON.stringify({ botToken: { iv: "aa", authTag: "bb", ciphertext: "cc" } }),
      setupSessionId: randomUUID(),
    };

    const result = await repo.upsert(config);
    expect(result.botId).toBe(botId);
    expect(result.pluginId).toBe(pluginId);

    const found = await repo.findByBotAndPlugin(botId, pluginId);
    expect(found).not.toBeNull();
    expect(found?.configJson).toBe(config.configJson);
  });

  it("overwrites on duplicate (botId, pluginId)", async () => {
    const botId = randomUUID();
    const pluginId = "discord-channel";
    const sessionId = randomUUID();

    await repo.upsert({
      id: randomUUID(),
      botId,
      pluginId,
      configJson: JSON.stringify({ botToken: "old" }),
      encryptedFieldsJson: null,
      setupSessionId: sessionId,
    });

    await repo.upsert({
      id: randomUUID(),
      botId,
      pluginId,
      configJson: JSON.stringify({ botToken: "new" }),
      encryptedFieldsJson: null,
      setupSessionId: sessionId,
    });

    const found = await repo.findByBotAndPlugin(botId, pluginId);
    expect(JSON.parse(found?.configJson ?? "{}")).toEqual({ botToken: "new" });
  });

  it("deletes by setup session ID", async () => {
    const sessionId = randomUUID();
    const botId = randomUUID();

    await repo.upsert({
      id: randomUUID(),
      botId,
      pluginId: "discord-channel",
      configJson: "{}",
      encryptedFieldsJson: null,
      setupSessionId: sessionId,
    });

    const count = await repo.deleteBySetupSession(sessionId);
    expect(count).toBe(1);

    const found = await repo.findByBotAndPlugin(botId, "discord-channel");
    expect(found).toBeNull();
  });

  it("deleteByBotAndPlugin returns false when not found", async () => {
    const result = await repo.deleteByBotAndPlugin(randomUUID(), "nonexistent");
    expect(result).toBe(false);
  });

  it("deleteByBotAndPlugin returns true and removes entry", async () => {
    const botId = randomUUID();
    const pluginId = "slack-channel";

    await repo.upsert({
      id: randomUUID(),
      botId,
      pluginId,
      configJson: "{}",
      encryptedFieldsJson: null,
      setupSessionId: null,
    });

    const result = await repo.deleteByBotAndPlugin(botId, pluginId);
    expect(result).toBe(true);

    const found = await repo.findByBotAndPlugin(botId, pluginId);
    expect(found).toBeNull();
  });
});
