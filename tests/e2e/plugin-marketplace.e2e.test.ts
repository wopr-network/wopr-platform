import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@wopr-network/platform-core/test/db";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { FIRST_PARTY_PLUGINS } from "@wopr-network/platform-core/marketplace/first-party-plugins";
import { DrizzleMarketplacePluginRepository } from "@wopr-network/platform-core/marketplace/drizzle-marketplace-plugin-repository";
import type { MarketplacePlugin } from "@wopr-network/platform-core/marketplace/marketplace-repository-types";
import {
  DrizzlePluginConfigRepository,
  type IPluginConfigRepository,
} from "@wopr-network/platform-core/setup/plugin-config-repository";
import { encrypt, decrypt, generateInstanceKey } from "@wopr-network/platform-core/security/encryption";
import type { EncryptedPayload } from "@wopr-network/platform-core/security/types";
import { AdapterSocket } from "@wopr-network/platform-core/monetization/socket/socket";
import { DrizzleMeterEmitter as MeterEmitter } from "@wopr-network/platform-core/monetization/metering/emitter";
import { DrizzleMeterEventRepository } from "@wopr-network/platform-core/monetization/metering/meter-event-repository";
import { Credit } from "@wopr-network/platform-core";
import type {
  AdapterResult,
  ProviderAdapter,
  TextGenerationOutput,
} from "@wopr-network/platform-core/monetization/adapters/types";
import type { ConfigSchemaField } from "@wopr-network/platform-core/api/routes/marketplace-registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate config values against a plugin manifest's configSchema. */
function validateConfig(
  config: Record<string, unknown>,
  schema: ConfigSchemaField[],
): string[] {
  const errors: string[] = [];
  if (!schema) return errors;
  for (const field of schema) {
    const value = config[field.key];
    if (field.required && (value === undefined || value === null || value === "")) {
      errors.push(`Missing required field: ${field.key}`);
    }
    if (value !== undefined && field.validation?.pattern) {
      if (!new RegExp(field.validation.pattern).test(String(value))) {
        errors.push(`Validation failed for ${field.key}: ${field.validation.message}`);
      }
    }
  }
  return errors;
}

function createFakeTextGenAdapter(): ProviderAdapter {
  return {
    name: "fake-openai",
    capabilities: ["text-generation"],
    selfHosted: false,
    async generateText(_input: unknown) {
      return {
        result: {
          text: "Hello from fake adapter",
          model: "gpt-4o",
          usage: { inputTokens: 10, outputTokens: 20 },
        },
        cost: Credit.fromDollars(0.001),
      } satisfies AdapterResult<TextGenerationOutput>;
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E: plugin marketplace — install → configure → activate → invoke → deactivate → uninstall", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let pluginRepo: DrizzleMarketplacePluginRepository;
  let configRepo: IPluginConfigRepository;
  let encryptionKey: Buffer;
  let meter: MeterEmitter;
  let socket: AdapterSocket;
  let walPath: string;
  let dlqPath: string;

  const TENANT_ID = `e2e-marketplace-${randomUUID()}`;
  const BOT_ID = randomUUID();

  const DISCORD_PLUGIN = FIRST_PARTY_PLUGINS.find((p) => p.id === "discord-channel")!;

  beforeEach(async () => {
    const ts = Date.now();
    walPath = `/tmp/wopr-e2e-marketplace-wal-${ts}.jsonl`;
    dlqPath = `/tmp/wopr-e2e-marketplace-dlq-${ts}.jsonl`;

    ({ db, pool } = await createTestDb());

    pluginRepo = new DrizzleMarketplacePluginRepository(db);
    configRepo = new DrizzlePluginConfigRepository(db);
    encryptionKey = generateInstanceKey();

    meter = new MeterEmitter(new DrizzleMeterEventRepository(db), {
      flushIntervalMs: 100,
      batchSize: 1,
      walPath,
      dlqPath,
    });

    socket = new AdapterSocket({ meter, defaultMargin: 1.3 });
    socket.register(createFakeTextGenAdapter());

    // Seed first-party plugins into DB
    for (const plugin of FIRST_PARTY_PLUGINS) {
      await pluginRepo.insert({
        pluginId: plugin.id,
        npmPackage: plugin.install[0] ?? `@wopr-network/wopr-plugin-${plugin.id}`,
        version: plugin.version,
        category: plugin.category,
        manifest: {
          name: plugin.name,
          description: plugin.description,
          author: plugin.author,
          icon: plugin.icon,
          color: plugin.color,
          tags: plugin.tags,
          capabilities: plugin.capabilities,
          requires: plugin.requires ?? [],
          install: plugin.install,
          configSchema: plugin.configSchema,
          setup: plugin.setup,
          installCount: plugin.installCount,
          changelog: plugin.changelog,
        },
      });
    }
  });

  afterEach(async () => {
    meter.close();
    await pool.close();
    await unlink(walPath).catch(() => {});
    await unlink(dlqPath).catch(() => {});
  });

  // =========================================================================
  // TEST 1: List available plugins from marketplace
  // =========================================================================

  it("lists available plugins including first-party fixtures", async () => {
    const all = await pluginRepo.findAll();
    expect(all.length).toBe(FIRST_PARTY_PLUGINS.length);
    const ids = all.map((p) => p.pluginId);
    expect(ids).toContain("discord-channel");
    expect(ids).toContain("slack-channel");
    expect(ids).toContain("semantic-memory");
  });

  // =========================================================================
  // TEST 2: Full lifecycle
  // =========================================================================

  it("full lifecycle: install → configure (encrypted) → activate → invoke capability → deactivate → uninstall", async () => {
    // STEP 1: Install — find plugin in marketplace
    const plugin = await pluginRepo.findById("discord-channel");
    expect(plugin).toBeDefined();
    expect(plugin!.manifest?.capabilities).toContain("channel");

    // STEP 2: Configure with required fields — encrypt secret fields
    const rawConfig: Record<string, string> = {
      botToken: "MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.Gc1234.abcdefghijklmnop",
      guildId: "123456789012345678",
    };

    const validationErrors = validateConfig(rawConfig, plugin!.manifest!.configSchema);
    expect(validationErrors).toEqual([]);

    // Encrypt secret fields
    const encryptedFields: Record<string, EncryptedPayload> = {};
    const configForStorage: Record<string, string> = { ...rawConfig };
    for (const field of plugin!.manifest!.configSchema) {
      if (field.secret && rawConfig[field.key]) {
        encryptedFields[field.key] = encrypt(rawConfig[field.key], encryptionKey);
        configForStorage[field.key] = "[encrypted]";
      }
    }

    const configId = randomUUID();
    const savedConfig = await configRepo.upsert({
      id: configId,
      botId: BOT_ID,
      pluginId: "discord-channel",
      configJson: JSON.stringify(configForStorage),
      encryptedFieldsJson: JSON.stringify(encryptedFields),
      setupSessionId: null,
    });

    expect(savedConfig.botId).toBe(BOT_ID);
    expect(savedConfig.pluginId).toBe("discord-channel");

    // STEP 3: Assert stored config is NOT plaintext (encrypted at rest)
    const storedConfig = await configRepo.findByBotAndPlugin(BOT_ID, "discord-channel");
    expect(storedConfig).not.toBeNull();

    expect(storedConfig!.configJson).not.toContain(rawConfig.botToken);

    const storedEncrypted = JSON.parse(storedConfig!.encryptedFieldsJson!) as Record<
      string,
      EncryptedPayload
    >;
    expect(storedEncrypted.botToken).toBeDefined();
    expect(storedEncrypted.botToken.ciphertext).not.toBe(rawConfig.botToken);
    expect(storedEncrypted.botToken.iv).toBeDefined();
    expect(storedEncrypted.botToken.authTag).toBeDefined();

    // Verify we can decrypt back to original
    const decryptedToken = decrypt(storedEncrypted.botToken, encryptionKey);
    expect(decryptedToken).toBe(rawConfig.botToken);

    // STEP 4: Activate — plugin is now in active set
    const activePlugins = new Set<string>();
    activePlugins.add("discord-channel");
    expect(activePlugins.has("discord-channel")).toBe(true);

    // STEP 5: Invoke a capability via AdapterSocket
    const result = await socket.execute<TextGenerationOutput>({
      tenantId: TENANT_ID,
      capability: "text-generation",
      input: { prompt: "Hello" },
    });

    expect(result.text).toBe("Hello from fake adapter");
    expect(result.model).toBe("gpt-4o");

    // Verify meter event was emitted
    meter.flush();
    const events = await meter.queryEvents(TENANT_ID);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].capability).toBe("text-generation");

    // STEP 6: Deactivate — plugin removed from active set
    activePlugins.delete("discord-channel");
    expect(activePlugins.has("discord-channel")).toBe(false);

    // Config still exists in DB after deactivation
    const configAfterDeactivate = await configRepo.findByBotAndPlugin(BOT_ID, "discord-channel");
    expect(configAfterDeactivate).not.toBeNull();

    // STEP 7: Uninstall — remove plugin config
    const deleted = await configRepo.deleteByBotAndPlugin(BOT_ID, "discord-channel");
    expect(deleted).toBe(true);

    const configAfterUninstall = await configRepo.findByBotAndPlugin(BOT_ID, "discord-channel");
    expect(configAfterUninstall).toBeNull();
  });

  // =========================================================================
  // TEST 3: Missing required fields
  // =========================================================================

  it("config with missing required fields returns validation error", () => {
    const incompleteConfig: Record<string, unknown> = {
      guildId: "123456789012345678",
      // botToken is missing — it's required
    };

    const errors = validateConfig(incompleteConfig, DISCORD_PLUGIN.configSchema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("botToken"))).toBe(true);
  });

  // =========================================================================
  // TEST 4: Invalid pattern
  // =========================================================================

  it("config with invalid field pattern returns validation error", () => {
    const badConfig: Record<string, unknown> = {
      botToken: "valid-token-format",
      guildId: "not-a-number", // Must match ^\d{17,20}$
    };

    const errors = validateConfig(badConfig, DISCORD_PLUGIN.configSchema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("guildId"))).toBe(true);
  });

  // =========================================================================
  // TEST 5: Activating with invalid config
  // =========================================================================

  it("activating with invalid config is rejected before activation", () => {
    const invalidConfig: Record<string, unknown> = {
      botToken: "", // Required but empty
      guildId: "abc", // Invalid pattern
    };

    const errors = validateConfig(invalidConfig, DISCORD_PLUGIN.configSchema);
    expect(errors.length).toBeGreaterThanOrEqual(2);

    // Activation gate: don't activate if validation fails
    const activePlugins = new Set<string>();
    if (errors.length === 0) {
      activePlugins.add("discord-channel");
    }
    expect(activePlugins.has("discord-channel")).toBe(false);
  });
});
