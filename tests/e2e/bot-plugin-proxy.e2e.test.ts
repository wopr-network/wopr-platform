import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleDb } from "../../src/db/index.js";
import { DrizzlePluginConfigRepository } from "../../src/setup/plugin-config-repository.js";
import { createTestDb } from "../../src/test/db.js";

// ---------------------------------------------------------------------------
// Auth tokens — set before importing route modules
// ---------------------------------------------------------------------------

const OPERATOR_TOKEN = "e2e-proxy-operator-token";
const TENANT_ID = "tenant-e2e-proxy";
const TENANT_TOKEN = "e2e-proxy-tenant-token";

vi.stubEnv("FLEET_API_TOKEN", OPERATOR_TOKEN);
vi.stubEnv(`FLEET_TOKEN_${TENANT_ID}`, `write:${TENANT_TOKEN}`);

// ---------------------------------------------------------------------------
// Daemon proxy mock — no real network calls in e2e
// ---------------------------------------------------------------------------

const proxyMock = vi.fn();
vi.mock("../../src/api/routes/friends-proxy.js", () => ({
  proxyToInstance: (...args: unknown[]) => proxyMock(...args),
}));

// ---------------------------------------------------------------------------
// IBotProfileRepository stub — bot profiles without a real DB
// ---------------------------------------------------------------------------

const storeMock = { get: vi.fn() };

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Dynamic import after env is set (auth reads env at module load)
// ---------------------------------------------------------------------------

const { createBotPluginProxyRoutes } = await import(
  "../../src/api/routes/bot-plugin-proxy.js"
);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const operatorAuth = { Authorization: `Bearer ${OPERATOR_TOKEN}` };
const tenantAuth = { Authorization: `Bearer ${TENANT_TOKEN}` };

const BOT_ID = "00000000-0000-4000-a000-000000000e2e";
const MISSING_BOT_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const PLUGIN_ID = "wopr-plugin-discord";

function makeProfile(overrides: Partial<{ tenantId: string }> = {}) {
  return {
    id: BOT_ID,
    tenantId: overrides.tenantId ?? TENANT_ID,
    name: "e2e-test-bot",
    description: "E2E test bot",
    image: "ghcr.io/wopr-network/wopr:stable",
    env: {},
    restartPolicy: "unless-stopped",
    releaseChannel: "stable",
    updatePolicy: "manual",
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E: bot plugin proxy — full HTTP lifecycle", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let app: Hono;

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    vi.resetAllMocks();

    const configRepo = new DrizzlePluginConfigRepository(db);
    const routes = createBotPluginProxyRoutes({ pluginConfigRepo: configRepo, profileRepo: storeMock });
    app = new Hono();
    app.route("/api/bots", routes);

    // Default: bot exists and belongs to TENANT_ID
    storeMock.get.mockImplementation((id: string) =>
      Promise.resolve(id === BOT_ID ? makeProfile() : null),
    );

    // Default: daemon responds OK
    proxyMock.mockResolvedValue({ ok: true, status: 200, data: { success: true } });
  });

  afterEach(async () => {
    await pool?.close();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  // =========================================================================
  // Install lifecycle
  // =========================================================================

  describe("POST /api/bots/:botId/plugins/install", () => {
    it("installs plugin and returns 200", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ pluginId: PLUGIN_ID }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(proxyMock).toHaveBeenCalledWith(BOT_ID, "POST", "/plugins/install", {
        source: PLUGIN_ID,
      });
    });

    it("forwards stored config to daemon after install when config exists in DB", async () => {
      const configRepo = new DrizzlePluginConfigRepository(db);
      // Pre-seed a config for this bot+plugin
      await configRepo.upsert({
        id: randomUUID(),
        botId: BOT_ID,
        pluginId: PLUGIN_ID,
        configJson: JSON.stringify({ botToken: "pre-seeded-token", guildId: "123456789012345678" }),
        encryptedFieldsJson: null,
        setupSessionId: null,
      });

      const res = await app.request(`/api/bots/${BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ pluginId: PLUGIN_ID }),
      });

      expect(res.status).toBe(200);
      // install call + config push call
      expect(proxyMock).toHaveBeenCalledTimes(2);
      expect(proxyMock).toHaveBeenNthCalledWith(2, BOT_ID, "PUT", `/plugins/${PLUGIN_ID}/config`, {
        config: { botToken: "pre-seeded-token", guildId: "123456789012345678" },
      });
    });

    it("returns 200 even if config push fails after install (non-fatal)", async () => {
      const configRepo = new DrizzlePluginConfigRepository(db);
      await configRepo.upsert({
        id: randomUUID(),
        botId: BOT_ID,
        pluginId: PLUGIN_ID,
        configJson: JSON.stringify({ key: "val" }),
        encryptedFieldsJson: null,
        setupSessionId: null,
      });

      // Install succeeds, config push fails
      proxyMock
        .mockResolvedValueOnce({ ok: true, status: 200, data: { success: true } })
        .mockRejectedValueOnce(new Error("network error"));

      const res = await app.request(`/api/bots/${BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ pluginId: PLUGIN_ID }),
      });

      // Still 200 — install succeeded, config push failure is non-fatal
      expect(res.status).toBe(200);
    });

    it("returns 404 when daemon reports package not found", async () => {
      proxyMock.mockResolvedValue({
        ok: false,
        status: 404,
        error: "Package not found: wopr-plugin-nonexistent",
      });

      const res = await app.request(`/api/bots/${BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ pluginId: "wopr-plugin-nonexistent" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/Package not found/);
    });

    it("returns 503 when daemon is offline", async () => {
      proxyMock.mockResolvedValue({ ok: false, status: 503, error: "Instance unavailable" });

      const res = await app.request(`/api/bots/${BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ pluginId: PLUGIN_ID }),
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toMatch(/unavailable/i);
    });

    it("returns 404 for non-existent bot", async () => {
      const res = await app.request(`/api/bots/${MISSING_BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ pluginId: PLUGIN_ID }),
      });

      expect(res.status).toBe(404);
      expect(proxyMock).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid botId (not a UUID)", async () => {
      const res = await app.request("/api/bots/not-a-uuid/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ pluginId: PLUGIN_ID }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for missing pluginId in body", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      expect(proxyMock).not.toHaveBeenCalled();
    });

    it("returns 400 for path-injection pluginId", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ pluginId: "../../../etc/passwd" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 401 without authorization header", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: PLUGIN_ID }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 404 when tenant-scoped token tries to access another tenant's bot", async () => {
      storeMock.get.mockResolvedValue(makeProfile({ tenantId: "other-tenant" }));

      const res = await app.request(`/api/bots/${BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tenantAuth },
        body: JSON.stringify({ pluginId: PLUGIN_ID }),
      });

      expect(res.status).toBe(404);
      expect(proxyMock).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Config update lifecycle
  // =========================================================================

  describe("PUT /api/bots/:botId/plugins/:pluginId/config", () => {
    it("persists config to DB and proxies to daemon, returns configSaved+daemonUpdated", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/${PLUGIN_ID}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ config: { botToken: "tok123", guildId: "111111111111111111" } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configSaved).toBe(true);
      expect(body.daemonUpdated).toBe(true);

      // Verify persisted to real DB
      const configRepo = new DrizzlePluginConfigRepository(db);
      const stored = await configRepo.findByBotAndPlugin(BOT_ID, PLUGIN_ID);
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!.configJson) as Record<string, unknown>;
      expect(parsed.botToken).toBe("tok123");
      expect(parsed.guildId).toBe("111111111111111111");

      // Daemon received the update
      expect(proxyMock).toHaveBeenCalledWith(BOT_ID, "PUT", `/plugins/${PLUGIN_ID}/config`, {
        config: { botToken: "tok123", guildId: "111111111111111111" },
      });
    });

    it("saves config to DB even when daemon is offline (daemonUpdated=false)", async () => {
      proxyMock.mockResolvedValue({ ok: false, status: 503, error: "Instance unavailable" });

      const res = await app.request(`/api/bots/${BOT_ID}/plugins/${PLUGIN_ID}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ config: { setting: "value" } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configSaved).toBe(true);
      expect(body.daemonUpdated).toBe(false);
      expect(body.daemonError).toMatch(/unavailable/i);

      // Config must still be in DB
      const configRepo = new DrizzlePluginConfigRepository(db);
      const stored = await configRepo.findByBotAndPlugin(BOT_ID, PLUGIN_ID);
      expect(stored).not.toBeNull();
    });

    it("upserts config on second call (idempotent)", async () => {
      const configRepo = new DrizzlePluginConfigRepository(db);
      const url = `/api/bots/${BOT_ID}/plugins/${PLUGIN_ID}/config`;
      const headers = { "Content-Type": "application/json", ...operatorAuth };

      await app.request(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ config: { version: "1" } }),
      });

      await app.request(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ config: { version: "2" } }),
      });

      const rows = await configRepo.findAllForBot(BOT_ID);
      expect(rows).toHaveLength(1);
      const parsed = JSON.parse(rows[0].configJson) as Record<string, unknown>;
      expect(parsed.version).toBe("2");
    });

    it("returns 400 for missing config field in body", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/${PLUGIN_ID}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ notConfig: {} }),
      });

      expect(res.status).toBe(400);
      expect(proxyMock).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid pluginId format", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/../../../evil/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ config: {} }),
      });

      // Hono normalizes paths; the route will not match or the validation will reject
      expect([400, 404]).toContain(res.status);
    });

    it("returns 404 for non-existent bot", async () => {
      const res = await app.request(`/api/bots/${MISSING_BOT_ID}/plugins/${PLUGIN_ID}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...operatorAuth },
        body: JSON.stringify({ config: { key: "val" } }),
      });

      expect(res.status).toBe(404);
      expect(proxyMock).not.toHaveBeenCalled();
    });

    it("returns 401 without authorization header", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/${PLUGIN_ID}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: {} }),
      });

      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Enable / disable lifecycle
  // =========================================================================

  describe("POST /api/bots/:botId/plugins/:pluginId/enable", () => {
    it("proxies enable to daemon and returns 200", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/${PLUGIN_ID}/enable`, {
        method: "POST",
        headers: operatorAuth,
      });

      expect(res.status).toBe(200);
      expect(proxyMock).toHaveBeenCalledWith(BOT_ID, "POST", `/plugins/${PLUGIN_ID}/enable`);
    });

    it("propagates daemon error status on enable failure", async () => {
      proxyMock.mockResolvedValue({ ok: false, status: 409, error: "Plugin already enabled" });

      const res = await app.request(`/api/bots/${BOT_ID}/plugins/${PLUGIN_ID}/enable`, {
        method: "POST",
        headers: operatorAuth,
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/already enabled/i);
    });

    it("returns 404 for non-existent bot", async () => {
      const res = await app.request(`/api/bots/${MISSING_BOT_ID}/plugins/${PLUGIN_ID}/enable`, {
        method: "POST",
        headers: operatorAuth,
      });

      expect(res.status).toBe(404);
      expect(proxyMock).not.toHaveBeenCalled();
    });

    it("returns 401 without authorization header", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/${PLUGIN_ID}/enable`, {
        method: "POST",
      });

      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/bots/:botId/plugins/:pluginId/disable", () => {
    it("proxies disable to daemon and returns 200", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/${PLUGIN_ID}/disable`, {
        method: "POST",
        headers: operatorAuth,
      });

      expect(res.status).toBe(200);
      expect(proxyMock).toHaveBeenCalledWith(BOT_ID, "POST", `/plugins/${PLUGIN_ID}/disable`);
    });

    it("propagates daemon error status on disable failure", async () => {
      proxyMock.mockResolvedValue({ ok: false, status: 404, error: "Plugin not installed" });

      const res = await app.request(`/api/bots/${BOT_ID}/plugins/${PLUGIN_ID}/disable`, {
        method: "POST",
        headers: operatorAuth,
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not installed/i);
    });

    it("returns 404 for non-existent bot", async () => {
      const res = await app.request(`/api/bots/${MISSING_BOT_ID}/plugins/${PLUGIN_ID}/disable`, {
        method: "POST",
        headers: operatorAuth,
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authorization header", async () => {
      const res = await app.request(`/api/bots/${BOT_ID}/plugins/${PLUGIN_ID}/disable`, {
        method: "POST",
      });

      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Full lifecycle: install → configure → enable → disable
  // =========================================================================

  describe("full plugin lifecycle: install → configure → enable → disable", () => {
    it("completes end-to-end without errors", async () => {
      const configRepo = new DrizzlePluginConfigRepository(db);
      const baseUrl = `/api/bots/${BOT_ID}/plugins`;
      const headers = { "Content-Type": "application/json", ...operatorAuth };

      // Step 1: Install plugin
      const installRes = await app.request(`${baseUrl}/install`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pluginId: PLUGIN_ID }),
      });
      expect(installRes.status).toBe(200);

      // Step 2: Configure plugin (persisted to real DB)
      const configRes = await app.request(`${baseUrl}/${PLUGIN_ID}/config`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ config: { botToken: "discord-bot-token", guildId: "987654321098765432" } }),
      });
      expect(configRes.status).toBe(200);
      const configBody = await configRes.json();
      expect(configBody.configSaved).toBe(true);
      expect(configBody.daemonUpdated).toBe(true);

      // Verify in DB
      const storedConfig = await configRepo.findByBotAndPlugin(BOT_ID, PLUGIN_ID);
      expect(storedConfig).not.toBeNull();
      expect(storedConfig!.botId).toBe(BOT_ID);
      expect(storedConfig!.pluginId).toBe(PLUGIN_ID);

      // Step 3: Enable plugin
      const enableRes = await app.request(`${baseUrl}/${PLUGIN_ID}/enable`, {
        method: "POST",
        headers: operatorAuth,
      });
      expect(enableRes.status).toBe(200);

      // Step 4: Disable plugin
      const disableRes = await app.request(`${baseUrl}/${PLUGIN_ID}/disable`, {
        method: "POST",
        headers: operatorAuth,
      });
      expect(disableRes.status).toBe(200);

      // Daemon was called for each operation: install, config-put, enable, disable
      expect(proxyMock).toHaveBeenCalledTimes(4);
      expect(proxyMock).toHaveBeenNthCalledWith(1, BOT_ID, "POST", "/plugins/install", {
        source: PLUGIN_ID,
      });
      expect(proxyMock).toHaveBeenNthCalledWith(2, BOT_ID, "PUT", `/plugins/${PLUGIN_ID}/config`, expect.any(Object));
      expect(proxyMock).toHaveBeenNthCalledWith(3, BOT_ID, "POST", `/plugins/${PLUGIN_ID}/enable`);
      expect(proxyMock).toHaveBeenNthCalledWith(4, BOT_ID, "POST", `/plugins/${PLUGIN_ID}/disable`);

      // Config remains in DB after lifecycle
      const finalConfig = await configRepo.findByBotAndPlugin(BOT_ID, PLUGIN_ID);
      expect(finalConfig).not.toBeNull();
    });

    it("re-install pushes previously saved config automatically", async () => {
      const configRepo = new DrizzlePluginConfigRepository(db);
      const baseUrl = `/api/bots/${BOT_ID}/plugins`;
      const headers = { "Content-Type": "application/json", ...operatorAuth };

      // First: configure (daemon offline — config saved to DB only)
      proxyMock.mockResolvedValueOnce({ ok: false, status: 503, error: "offline" });
      await app.request(`${baseUrl}/${PLUGIN_ID}/config`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ config: { restored: true } }),
      });

      // Verify config is in DB despite daemon being offline
      const stored = await configRepo.findByBotAndPlugin(BOT_ID, PLUGIN_ID);
      expect(stored).not.toBeNull();

      // Now daemon comes back online — install again
      proxyMock.mockReset();
      proxyMock.mockResolvedValue({ ok: true, status: 200, data: { success: true } });

      const installRes = await app.request(`${baseUrl}/install`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pluginId: PLUGIN_ID }),
      });
      expect(installRes.status).toBe(200);

      // Config should have been pushed automatically
      expect(proxyMock).toHaveBeenCalledTimes(2);
      expect(proxyMock).toHaveBeenNthCalledWith(2, BOT_ID, "PUT", `/plugins/${PLUGIN_ID}/config`, {
        config: { restored: true },
      });
    });
  });
});
