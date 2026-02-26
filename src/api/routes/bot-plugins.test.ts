import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Set env var BEFORE importing bot-plugin routes so bearer auth uses this token
const TEST_TOKEN = "test-plugin-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };

/** Stable UUIDs for test bots. */
const TEST_BOT_ID = "00000000-0000-4000-8000-000000000002";
/** A valid UUID for a bot that does not exist. */
const MISSING_BOT_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const TEST_NODE_ID = "node-1";
const TEST_TENANT_ID = "user-123";

const mockProfile = {
  id: TEST_BOT_ID,
  tenantId: TEST_TENANT_ID,
  name: "test-bot",
  description: "A test bot",
  image: "ghcr.io/wopr-network/wopr:stable",
  env: { TOKEN: "abc" },
  restartPolicy: "unless-stopped",
  releaseChannel: "stable",
  updatePolicy: "manual",
};

const storeMock = {
  get: vi.fn(),
  save: vi.fn(),
};

const fleetMock = {
  update: vi.fn(),
};

const vaultMock = {
  getActiveForProvider: vi.fn(),
};

const meterMock = {
  emit: vi.fn(),
};

vi.mock("../../fleet/profile-store.js", () => {
  return {
    ProfileStore: class {
      get = storeMock.get;
      save = storeMock.save;
    },
  };
});

vi.mock("./fleet.js", () => ({
  fleet: fleetMock,
}));

// Mock fleet services (DB + NodeConnectionManager)
const mockBotInstance = {
  id: TEST_BOT_ID,
  tenantId: TEST_TENANT_ID,
  name: "test-bot",
  nodeId: TEST_NODE_ID,
};

const mockDbChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue([mockBotInstance]),
  get: vi.fn(),
};

const mockDb = {
  select: vi.fn().mockReturnValue(mockDbChain),
};

const mockNodeConnections = {
  send: vi.fn(),
  isConnected: vi.fn(),
};

vi.mock("../../fleet/services.js", () => ({
  getDb: () => mockDb,
  getCommandBus: () => mockNodeConnections,
}));

// Import AFTER mocks are set up
const { botPluginRoutes, setBotPluginDeps } = await import("./bot-plugins.js");

// Wire in mock deps
setBotPluginDeps({
  credentialVault: vaultMock,
  meterEmitter: meterMock,
});

const app = new Hono();
app.route("/fleet", botPluginRoutes);

describe("bot-plugin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.get.mockImplementation((id: string) => {
      if (id === TEST_BOT_ID) return Promise.resolve({ ...mockProfile });
      return Promise.resolve(null);
    });
    storeMock.save.mockResolvedValue(undefined);
    fleetMock.update.mockResolvedValue(undefined);
    vaultMock.getActiveForProvider.mockReturnValue([]);
    meterMock.emit.mockReturnValue(undefined);
    mockNodeConnections.send.mockResolvedValue({ success: true });
    mockNodeConnections.isConnected.mockReturnValue(true);
    // Reset the chain mock — where() returns a Promise resolving to array (PG Drizzle style)
    mockDb.select.mockReturnValue(mockDbChain);
    mockDbChain.from.mockReturnThis();
    mockDbChain.where.mockResolvedValue([mockBotInstance]);
  });

  describe("POST /fleet/bots/:botId/plugins/:pluginId", () => {
    it("successfully installs a plugin and returns 200", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/wopr-plugin-discord`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config: { token: "abc" }, providerChoices: {} }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.botId).toBe(TEST_BOT_ID);
      expect(body.pluginId).toBe("wopr-plugin-discord");
      expect(body.installedPlugins).toContain("wopr-plugin-discord");
      expect(fleetMock.update).toHaveBeenCalledWith(
        TEST_BOT_ID,
        expect.objectContaining({
          env: expect.objectContaining({ WOPR_PLUGINS: "wopr-plugin-discord" }),
        }),
      );
    });

    it("returns 400 for invalid botId (not a UUID)", async () => {
      const res = await app.request("/fleet/bots/not-a-uuid/plugins/wopr-plugin-discord", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent botId", async () => {
      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/plugins/wopr-plugin-discord`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid pluginId format", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/--invalid--`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid plugin ID/);
    });

    it("returns 409 when plugin is already installed", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "wopr-plugin-discord" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/wopr-plugin-discord`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/already installed/);
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/wopr-plugin-discord`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "not json{{{",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 401 without auth token", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/wopr-plugin-discord`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(401);
    });

    it("stores plugin config in env under WOPR_PLUGIN_<ID>_CONFIG key", async () => {
      const config = { token: "abc123", prefix: "!" };
      const providerChoices = {};
      fleetMock.update.mockResolvedValue({});

      await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/my-plugin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config, providerChoices }),
      });

      expect(fleetMock.update).toHaveBeenCalledWith(TEST_BOT_ID, {
        env: expect.objectContaining({
          WOPR_PLUGIN_MY_PLUGIN_CONFIG: JSON.stringify({ config, providerChoices }),
          WOPR_PLUGINS: "my-plugin",
        }),
      });
    });

    it("appends to existing WOPR_PLUGINS list", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "existing-plugin" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/new-plugin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.installedPlugins).toEqual(["existing-plugin", "new-plugin"]);
    });

    it("re-fetches profile before save to avoid clobbering concurrent installs", async () => {
      // First store.get() returns empty plugins (for auth/validation)
      // Second store.get() returns a profile where plugin-a was installed concurrently
      let callCount = 0;
      storeMock.get.mockImplementation((id: string) => {
        if (id !== TEST_BOT_ID) return Promise.resolve(null);
        callCount++;
        if (callCount <= 1) {
          // First call: no plugins installed (used for validation)
          return Promise.resolve({ ...mockProfile, env: { TOKEN: "abc" } });
        }
        // Second call (re-fetch): plugin-a was installed concurrently
        return Promise.resolve({
          ...mockProfile,
          env: { TOKEN: "abc", WOPR_PLUGINS: "plugin-a" },
        });
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-b`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      // store.get must have been called twice (initial + re-fetch)
      expect(storeMock.get).toHaveBeenCalledTimes(2);
      // fleet.update must be called with BOTH plugins
      expect(fleetMock.update).toHaveBeenCalledWith(
        TEST_BOT_ID,
        expect.objectContaining({
          env: expect.objectContaining({
            WOPR_PLUGINS: "plugin-a,plugin-b",
          }),
        }),
      );
    });

    it("returns 409 if plugin was installed concurrently between reads", async () => {
      // First get: no plugins. Second get: plugin-b already installed by concurrent request.
      let callCount = 0;
      storeMock.get.mockImplementation((id: string) => {
        if (id !== TEST_BOT_ID) return Promise.resolve(null);
        callCount++;
        if (callCount <= 1) {
          return Promise.resolve({ ...mockProfile, env: { TOKEN: "abc" } });
        }
        return Promise.resolve({
          ...mockProfile,
          env: { TOKEN: "abc", WOPR_PLUGINS: "plugin-b" },
        });
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-b`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(409);
      expect(fleetMock.update).not.toHaveBeenCalled();
    });

    it("returns 404 if profile was deleted between reads", async () => {
      let callCount = 0;
      storeMock.get.mockImplementation((id: string) => {
        if (id !== TEST_BOT_ID) return Promise.resolve(null);
        callCount++;
        if (callCount <= 1) {
          return Promise.resolve({ ...mockProfile });
        }
        // Profile deleted between first read and re-fetch
        return Promise.resolve(null);
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-c`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
      expect(fleetMock.update).not.toHaveBeenCalled();
    });

    it("injects hosted credential env var when providerChoices has hosted entry", async () => {
      vaultMock.getActiveForProvider.mockImplementation((provider: string) => {
        if (provider === "elevenlabs") {
          return [
            {
              id: "cred-1",
              provider: "elevenlabs",
              keyName: "prod",
              plaintextKey: "sk-eleven-test",
              authType: "header",
              authHeader: null,
            },
          ];
        }
        return [];
      });
      fleetMock.update.mockResolvedValue({});

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/my-tts-plugin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          config: {},
          providerChoices: { tts: "hosted" },
        }),
      });

      expect(res.status).toBe(200);
      expect(fleetMock.update).toHaveBeenCalledWith(
        TEST_BOT_ID,
        expect.objectContaining({
          env: expect.objectContaining({
            ELEVENLABS_API_KEY: "sk-eleven-test",
            WOPR_HOSTED_KEYS: "ELEVENLABS_API_KEY",
          }),
        }),
      );
    });

    it("does not inject env var when providerChoices has byok entry", async () => {
      fleetMock.update.mockResolvedValue({});

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/my-tts-plugin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          config: {},
          providerChoices: { tts: "byok" },
        }),
      });

      expect(res.status).toBe(200);
      expect(fleetMock.update).toHaveBeenCalledWith(
        TEST_BOT_ID,
        expect.objectContaining({
          env: expect.not.objectContaining({
            ELEVENLABS_API_KEY: expect.anything(),
          }),
        }),
      );
    });

    it("returns 400 for unknown capability in providerChoices", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/my-plugin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          config: {},
          providerChoices: { "unknown-capability": "hosted" },
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Unknown capability/);
    });

    it("returns 503 when no platform credential exists for hosted capability", async () => {
      vaultMock.getActiveForProvider.mockReturnValue([]);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/my-tts-plugin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          config: {},
          providerChoices: { tts: "hosted" },
        }),
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toMatch(/No platform credential/);
    });

    it("emits a meter event for each hosted activation", async () => {
      vaultMock.getActiveForProvider.mockImplementation((provider: string) => {
        if (provider === "elevenlabs") {
          return [
            {
              id: "cred-1",
              provider: "elevenlabs",
              keyName: "prod",
              plaintextKey: "sk-test",
              authType: "header",
              authHeader: null,
            },
          ];
        }
        return [];
      });
      fleetMock.update.mockResolvedValue({});

      await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/my-tts-plugin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          config: {},
          providerChoices: { tts: "hosted" },
        }),
      });

      expect(meterMock.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: "user-123",
          capability: "hosted-activation",
          provider: "elevenlabs",
          cost: 0,
          charge: 0,
        }),
      );
    });
  });

  describe("DELETE /fleet/bots/:botId/plugins/:pluginId", () => {
    it("removes a plugin and its config env var", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: {
          TOKEN: "abc",
          WOPR_PLUGINS: "plugin-a,plugin-b",
          WOPR_PLUGIN_PLUGIN_A_CONFIG: '{"foo":"bar"}',
        },
      });
      fleetMock.update.mockResolvedValue({});

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-a`, {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.pluginId).toBe("plugin-a");

      expect(fleetMock.update).toHaveBeenCalledWith(
        TEST_BOT_ID,
        expect.objectContaining({
          env: expect.objectContaining({
            WOPR_PLUGINS: "plugin-b",
          }),
        }),
      );
      // Config key should be removed
      const savedEnv = fleetMock.update.mock.calls[0][1].env;
      expect(savedEnv).not.toHaveProperty("WOPR_PLUGIN_PLUGIN_A_CONFIG");
    });

    it("removes hosted env keys when last plugin is uninstalled", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: {
          TOKEN: "abc",
          WOPR_PLUGINS: "my-tts-plugin",
          WOPR_PLUGIN_MY_TTS_PLUGIN_CONFIG: JSON.stringify({ config: {}, providerChoices: { tts: "hosted" } }),
          ELEVENLABS_API_KEY: "sk-test",
          WOPR_HOSTED_KEYS: "ELEVENLABS_API_KEY",
        },
      });
      fleetMock.update.mockResolvedValue({});

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/my-tts-plugin`, {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const savedEnv = fleetMock.update.mock.calls[0][1].env;
      expect(savedEnv).not.toHaveProperty("ELEVENLABS_API_KEY");
      expect(savedEnv).not.toHaveProperty("WOPR_HOSTED_KEYS");
    });

    it("removes only the deleted plugin's hosted keys when other plugins remain", async () => {
      // plugin-tts (tts: hosted → ELEVENLABS_API_KEY) and plugin-llm (llm: hosted → OPENROUTER_API_KEY) are both installed.
      // Deleting plugin-tts should remove ELEVENLABS_API_KEY but keep OPENROUTER_API_KEY.
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: {
          TOKEN: "abc",
          WOPR_PLUGINS: "plugin-tts,plugin-llm",
          WOPR_PLUGIN_PLUGIN_TTS_CONFIG: JSON.stringify({ config: {}, providerChoices: { tts: "hosted" } }),
          WOPR_PLUGIN_PLUGIN_LLM_CONFIG: JSON.stringify({ config: {}, providerChoices: { llm: "hosted" } }),
          ELEVENLABS_API_KEY: "sk-eleven-test",
          OPENROUTER_API_KEY: "sk-openrouter-test",
          WOPR_HOSTED_KEYS: "ELEVENLABS_API_KEY,OPENROUTER_API_KEY",
        },
      });
      fleetMock.update.mockResolvedValue({});

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-tts`, {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const savedEnv = fleetMock.update.mock.calls[0][1].env;
      // TTS plugin's key should be gone
      expect(savedEnv).not.toHaveProperty("ELEVENLABS_API_KEY");
      // LLM plugin's key must remain
      expect(savedEnv).toHaveProperty("OPENROUTER_API_KEY", "sk-openrouter-test");
      // WOPR_HOSTED_KEYS should reflect only the remaining key
      expect(savedEnv.WOPR_HOSTED_KEYS).toBe("OPENROUTER_API_KEY");
      // plugin-llm must still be in WOPR_PLUGINS
      expect(savedEnv.WOPR_PLUGINS).toBe("plugin-llm");
    });

    it("returns 404 when plugin is not installed", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/not-installed`, {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for non-existent bot", async () => {
      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/plugins/some-plugin`, {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without auth token", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/some-plugin`, {
        method: "DELETE",
      });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /fleet/bots/:botId/plugins", () => {
    it("returns list of installed plugins", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "plugin-a,plugin-b" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins`, {
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.botId).toBe(TEST_BOT_ID);
      expect(body.plugins).toEqual([
        { pluginId: "plugin-a", enabled: true },
        { pluginId: "plugin-b", enabled: true },
      ]);
    });

    it("returns disabled plugins with enabled: false", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: {
          TOKEN: "abc",
          WOPR_PLUGINS: "plugin-a,plugin-b",
          WOPR_PLUGINS_DISABLED: "plugin-a",
        },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins`, {
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.plugins).toEqual([
        { pluginId: "plugin-a", enabled: false },
        { pluginId: "plugin-b", enabled: true },
      ]);
    });

    it("returns empty list when no plugins installed", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins`, {
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.plugins).toEqual([]);
    });

    it("returns 404 for non-existent botId", async () => {
      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/plugins`, {
        headers: authHeader,
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without auth token", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins`);
      expect(res.status).toBe(401);
    });
  });

  describe("PUT /fleet/bots/:botId/plugins/:pluginId (alias for PATCH)", () => {
    it("disables an installed plugin via PUT", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "plugin-a,plugin-b" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-a`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.enabled).toBe(false);
    });

    it("re-enables a disabled plugin via PUT", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "plugin-a", WOPR_PLUGINS_DISABLED: "plugin-a" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-a`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ enabled: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.enabled).toBe(true);
    });

    it("returns 401 without auth token (PUT)", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-a`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /fleet/bots/:botId/plugins/:pluginId", () => {
    it("disables an installed plugin", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "plugin-a,plugin-b" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-a`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.enabled).toBe(false);
      expect(body.dispatched).toBe(true);
      expect(storeMock.save).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            WOPR_PLUGINS_DISABLED: "plugin-a",
          }),
        }),
      );
    });

    it("re-enables a disabled plugin", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "plugin-a", WOPR_PLUGINS_DISABLED: "plugin-a" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-a`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ enabled: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.enabled).toBe(true);
      expect(body.dispatched).toBe(true);
      // WOPR_PLUGINS_DISABLED should be removed when empty
      expect(storeMock.save).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.not.objectContaining({
            WOPR_PLUGINS_DISABLED: expect.anything(),
          }),
        }),
      );
    });

    it("returns 404 for plugin not installed on bot", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/not-installed`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid body (missing enabled)", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "plugin-a" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-a`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 401 without auth token", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-a`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(401);
    });

    it("dispatches bot.update when toggling plugin state", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "plugin-a,plugin-b" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/plugin-a`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ enabled: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dispatched).toBe(true);
      expect(mockNodeConnections.send).toHaveBeenCalledWith(
        TEST_NODE_ID,
        expect.objectContaining({ type: "bot.update" }),
      );
    });
  });

  describe("GET /fleet/bots/:botId/channels", () => {
    it("returns only channel-category plugins", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "discord-channel,semantic-memory" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels`, {
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.botId).toBe(TEST_BOT_ID);
      // discord-channel is category "channel", semantic-memory is "memory"
      expect(body.channels).toEqual([{ pluginId: "discord-channel", enabled: true }]);
    });

    it("returns empty array when no channel plugins installed", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "semantic-memory" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels`, {
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.channels).toEqual([]);
    });

    it("returns empty array when no plugins installed", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels`, {
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.channels).toEqual([]);
    });

    it("returns 404 for non-existent bot", async () => {
      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/channels`, {
        headers: authHeader,
      });
      expect(res.status).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels`);
      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid botId on channel routes", async () => {
      const res = await app.request("/fleet/bots/not-a-uuid/channels", {
        headers: authHeader,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid bot ID");
    });
  });

  describe("POST /fleet/bots/:botId/channels/:pluginId", () => {
    it("installs a channel plugin", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels/discord-channel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config: { botToken: "abc" }, providerChoices: {} }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.pluginId).toBe("discord-channel");
    });

    it("returns 409 when channel plugin already installed", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "discord-channel" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels/discord-channel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config: {}, providerChoices: {} }),
      });

      expect(res.status).toBe(409);
    });

    it("returns 400 for non-channel plugin", async () => {
      // semantic-memory is category "memory", not "channel"
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels/semantic-memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config: {}, providerChoices: {} }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/not a channel/i);
    });

    it("returns 400 for unknown plugin (not in registry)", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels/unknown-plugin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config: {}, providerChoices: {} }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/not a channel/i);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels/discord-channel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /fleet/bots/:botId/channels/:pluginId", () => {
    it("disconnects a channel plugin", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "discord-channel" },
      });
      fleetMock.update.mockResolvedValue({});

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels/discord-channel`, {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.pluginId).toBe("discord-channel");
    });

    it("returns 400 for non-channel plugin", async () => {
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        env: { TOKEN: "abc", WOPR_PLUGINS: "semantic-memory" },
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels/semantic-memory`, {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/not a channel/i);
    });

    it("returns 404 when channel plugin not installed on bot", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels/discord-channel`, {
        method: "DELETE",
        headers: authHeader,
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for non-existent bot", async () => {
      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/channels/discord-channel`, {
        method: "DELETE",
        headers: authHeader,
      });
      expect(res.status).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/channels/discord-channel`, {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });
  });
});
