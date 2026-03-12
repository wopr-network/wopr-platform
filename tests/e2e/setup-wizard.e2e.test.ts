import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSetupRoutes, type SetupRouteDeps } from "../../src/api/routes/setup.js";
import type { PluginManifest } from "@wopr-network/platform-core/api/routes/marketplace-registry";
import type { DrizzleDb } from "@wopr-network/platform-core/db/index";
import { DrizzlePluginConfigRepository } from "@wopr-network/platform-core/setup/plugin-config-repository";
import { DrizzleSetupSessionRepository } from "@wopr-network/platform-core/setup/setup-session-repository";
import { SetupService } from "@wopr-network/platform-core/setup/setup-service";
import { createTestDb } from "@wopr-network/platform-core/test/db";

const TEST_PLUGIN: PluginManifest = {
  id: "discord",
  name: "Discord",
  description: "Discord bot plugin",
  version: "1.0.0",
  author: "WOPR Network",
  icon: "discord",
  color: "#5865F2",
  category: "channel",
  tags: ["discord"],
  capabilities: ["messaging"],
  requires: [],
  install: ["@wopr-network/wopr-plugin-discord"],
  configSchema: [
    { key: "token", label: "Bot Token", type: "string", required: true, secret: true, env: "DISCORD_TOKEN" },
    { key: "guildId", label: "Guild ID", type: "string", required: true, env: "DISCORD_GUILD_ID" },
  ],
  setup: [],
  installCount: 0,
  changelog: [],
};

describe("E2E: setup wizard — fresh tenant → setup session → configure bot → complete", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let sessionRepo: DrizzleSetupSessionRepository;
  let pluginConfigRepo: DrizzlePluginConfigRepository;
  let setupService: SetupService;

  const TENANT_ID = `e2e-setup-${randomUUID()}`;
  const BOT_ID = randomUUID();
  const SESSION_ID = `chat-session-${randomUUID()}`;

  function makeDeps(overrides: Partial<SetupRouteDeps> = {}): SetupRouteDeps {
    return {
      pluginRegistry: [TEST_PLUGIN],
      setupSessionRepo: sessionRepo,
      onboardingService: { inject: vi.fn().mockResolvedValue("ok") },
      setupService,
      checkProvider: vi.fn().mockResolvedValue({ configured: true, provider: "anthropic" }),
      pluginConfigRepo,
      profileStore: {
        get: vi.fn().mockResolvedValue({ id: BOT_ID, tenantId: TENANT_ID, env: {} }),
        save: vi.fn().mockResolvedValue(undefined),
      },
      dispatchEnvUpdate: vi.fn().mockResolvedValue({ dispatched: true }),
      dispatchPluginInstall: vi.fn().mockResolvedValue({ dispatched: true }),
      dispatchPluginConfig: vi.fn().mockResolvedValue({ dispatched: true }),
      fetchPluginDependencies: vi.fn().mockResolvedValue([]),
      platformEncryptionSecret: "test-secret-32-bytes-long-padding!",
      ...overrides,
    };
  }

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    sessionRepo = new DrizzleSetupSessionRepository(db);
    pluginConfigRepo = new DrizzlePluginConfigRepository(db);
    setupService = new SetupService(sessionRepo, pluginConfigRepo);
  });

  afterEach(async () => {
    if (pool) await pool.close();
  });

  // =========================================================================
  // TEST 1: Fresh tenant creates a setup session
  // =========================================================================

  it("creates a setup session for a fresh tenant", async () => {
    const app = createSetupRoutes(makeDeps());

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION_ID, pluginId: "discord" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.setupSessionId).toBeDefined();

    // Verify session persisted in DB
    const session = await sessionRepo.findById(body.setupSessionId);
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe(SESSION_ID);
    expect(session!.pluginId).toBe("discord");
    expect(session!.status).toBe("in_progress");
  });

  // =========================================================================
  // TEST 2: Concurrent setup session rejected (409)
  // =========================================================================

  it("rejects concurrent setup session for same chat session (409)", async () => {
    const app = createSetupRoutes(makeDeps());

    // Send both requests concurrently — the DB unique constraint ensures exactly
    // one succeeds (200) and the other is rejected (409)
    const [res1, res2] = await Promise.all([
      app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID, pluginId: "discord" }),
      }),
      app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID, pluginId: "discord" }),
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // One must succeed (200) and the other must be rejected (409)
    expect(statuses).toEqual([200, 409]);

    const failedRes = res1.status === 409 ? res1 : res2;
    const body = await failedRes.json();
    expect(body.error).toContain("already in progress");
  });

  // =========================================================================
  // TEST 3: Save plugin config with encryption
  // =========================================================================

  it("saves plugin config, encrypts secrets, and updates session collected data", async () => {
    const deps = makeDeps();
    const app = createSetupRoutes(deps);

    // Create session first
    const createRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION_ID, pluginId: "discord" }),
    });
    const { setupSessionId } = await createRes.json();

    // Save config
    const saveRes = await app.request("/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-authenticated-tenant-id": TENANT_ID,
      },
      body: JSON.stringify({
        setupSessionId,
        botId: BOT_ID,
        values: { token: "bot-token-secret", guildId: "123456" },
      }),
    });

    expect(saveRes.status).toBe(200);
    const saveBody = await saveRes.json();
    expect(saveBody.ok).toBe(true);
    expect(saveBody.envKeysInjected).toContain("DISCORD_TOKEN");
    expect(saveBody.envKeysInjected).toContain("DISCORD_GUILD_ID");

    // Verify plugin config persisted in DB
    const pluginConfig = await pluginConfigRepo.findByBotAndPlugin(BOT_ID, "discord");
    expect(pluginConfig).not.toBeNull();
    // configJson must not contain plaintext secrets — only non-secret fields
    const configValues = JSON.parse(pluginConfig!.configJson);
    expect(configValues.token).toBeUndefined(); // secret field must be absent from configJson
    expect(configValues.guildId).toBe("123456");

    // Verify encrypted fields exist for secret field
    expect(pluginConfig!.encryptedFieldsJson).not.toBeNull();
    const encrypted = JSON.parse(pluginConfig!.encryptedFieldsJson!);
    expect(encrypted.token).toBeDefined();
    expect(encrypted.token).not.toBe("bot-token-secret"); // should be encrypted

    // Verify session collected data updated
    const session = await sessionRepo.findById(setupSessionId);
    expect(session!.collected).not.toBeNull();
    const collected = JSON.parse(session!.collected!);
    expect(collected.token).toBeUndefined(); // secret field excluded from collected data
    expect(collected.guildId).toBe("123456");

    // Verify error count was reset (recordSuccess called)
    expect(session!.errorCount).toBe(0);
  });

  // =========================================================================
  // TEST 4: Complete setup and verify completed state
  // =========================================================================

  it("completes setup and re-entering shows no resumable session", async () => {
    const app = createSetupRoutes(makeDeps());

    // Create session
    const createRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION_ID, pluginId: "discord" }),
    });
    const { setupSessionId } = await createRes.json();

    // Complete setup
    const completeRes = await app.request("/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupSessionId }),
    });
    expect(completeRes.status).toBe(200);
    const completeBody = await completeRes.json();
    expect(completeBody.ok).toBe(true);

    // Verify session is complete in DB
    const session = await sessionRepo.findById(setupSessionId);
    expect(session!.status).toBe("complete");
    expect(session!.completedAt).not.toBeNull();

    // Re-entering: check for resumable returns false (completed session not resumable)
    const resumeRes = await app.request(`/resume?sessionId=${SESSION_ID}`);
    expect(resumeRes.status).toBe(200);
    const resumeBody = await resumeRes.json();
    expect(resumeBody.hasStaleSession).toBe(false);

    // Can start a new setup session for a new chat session
    const newSessionId = `chat-session-${randomUUID()}`;
    const newRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: newSessionId, pluginId: "discord" }),
    });
    expect(newRes.status).toBe(200);
  });

  // =========================================================================
  // TEST 5: Resume abandoned in-progress session
  // =========================================================================

  it("can resume an abandoned in-progress session", async () => {
    const app = createSetupRoutes(makeDeps());

    // Create session
    const createRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION_ID, pluginId: "discord" }),
    });
    const { setupSessionId } = await createRes.json();

    // Check for resumable — should find the in-progress session
    const resumeRes = await app.request(`/resume?sessionId=${SESSION_ID}`);
    expect(resumeRes.status).toBe(200);
    const resumeBody = await resumeRes.json();
    expect(resumeBody.hasStaleSession).toBe(true);
    expect(resumeBody.session).toBeDefined();
    expect(resumeBody.session.id).toBe(setupSessionId);
    expect(resumeBody.session.status).toBe("in_progress");
  });

  // =========================================================================
  // TEST 6: Save rejected without auth header (401)
  // =========================================================================

  it("rejects /save without x-authenticated-tenant-id header (401)", async () => {
    const app = createSetupRoutes(makeDeps());

    // Create session
    const createRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION_ID, pluginId: "discord" }),
    });
    const { setupSessionId } = await createRes.json();

    // Save without auth header
    const saveRes = await app.request("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        setupSessionId,
        botId: BOT_ID,
        values: { token: "bot-token-secret", guildId: "123456" },
      }),
    });

    expect(saveRes.status).toBe(401);
  });

  // =========================================================================
  // TEST 7: Rollback clears collected data
  // =========================================================================

  it("rollback clears collected config and marks session rolled_back", async () => {
    const deps = makeDeps();
    const app = createSetupRoutes(deps);

    // Create session
    const createRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION_ID, pluginId: "discord" }),
    });
    const { setupSessionId } = await createRes.json();

    // Save some config first
    await app.request("/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-authenticated-tenant-id": TENANT_ID,
      },
      body: JSON.stringify({
        setupSessionId,
        botId: BOT_ID,
        values: { token: "bot-token-secret", guildId: "123456" },
      }),
    });

    // Rollback
    const rollbackRes = await app.request("/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupSessionId }),
    });
    expect(rollbackRes.status).toBe(200);
    const rollbackBody = await rollbackRes.json();
    expect(rollbackBody.ok).toBe(true);

    // Verify session rolled back in DB
    const session = await sessionRepo.findById(setupSessionId);
    expect(session!.status).toBe("rolled_back");
    expect(session!.collected).toBeNull();

    // Verify plugin config was cleaned up by rollback
    const pluginConfig = await pluginConfigRepo.findByBotAndPlugin(BOT_ID, "discord");
    expect(pluginConfig).toBeNull();

    // After rollback, resume returns false (rolled_back is not in_progress)
    const resumeRes = await app.request(`/resume?sessionId=${SESSION_ID}`);
    const resumeBody = await resumeRes.json();
    expect(resumeBody.hasStaleSession).toBe(false);
  });
});
