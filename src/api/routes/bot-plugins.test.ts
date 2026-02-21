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

vi.mock("../../fleet/profile-store.js", () => {
  return {
    ProfileStore: class {
      get = storeMock.get;
      save = storeMock.save;
    },
  };
});

// Mock fleet services (DB + NodeConnectionManager)
const mockDbChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  get: vi.fn(),
};

const mockDb = {
  select: vi.fn().mockReturnValue(mockDbChain),
};

const mockNodeConnections = {
  sendCommand: vi.fn(),
  isConnected: vi.fn(),
};

vi.mock("../../fleet/services.js", () => ({
  getDb: () => mockDb,
  getNodeConnections: () => mockNodeConnections,
}));

// Import AFTER mocks are set up
const { botPluginRoutes } = await import("./bot-plugins.js");

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
    // Default: bot is deployed to TEST_NODE_ID
    mockDbChain.get.mockReturnValue({
      id: TEST_BOT_ID,
      tenantId: TEST_TENANT_ID,
      name: "test-bot",
      nodeId: TEST_NODE_ID,
    });
    mockNodeConnections.sendCommand.mockResolvedValue({ success: true });
    mockNodeConnections.isConnected.mockReturnValue(true);
    // Reset the chain mock
    mockDb.select.mockReturnValue(mockDbChain);
    mockDbChain.from.mockReturnThis();
    mockDbChain.where.mockReturnThis();
  });

  describe("POST /fleet/bots/:botId/plugins/:pluginId", () => {
    it("successfully installs a plugin and returns 200 with dispatched: true", async () => {
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
      expect(body.dispatched).toBe(true);
      expect(storeMock.save).toHaveBeenCalledWith(
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

      await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/my-plugin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config, providerChoices: {} }),
      });

      expect(storeMock.save).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            WOPR_PLUGIN_MY_PLUGIN_CONFIG: JSON.stringify(config),
            WOPR_PLUGINS: "my-plugin",
          }),
        }),
      );
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
      // store.save must be called with BOTH plugins
      expect(storeMock.save).toHaveBeenCalledWith(
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
      expect(storeMock.save).not.toHaveBeenCalled();
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
      expect(storeMock.save).not.toHaveBeenCalled();
    });

    it("dispatches bot.update to the correct node after install", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/wopr-plugin-discord`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config: { token: "abc" }, providerChoices: {} }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dispatched).toBe(true);
      expect(mockNodeConnections.sendCommand).toHaveBeenCalledWith(
        TEST_NODE_ID,
        expect.objectContaining({
          type: "bot.update",
          payload: expect.objectContaining({
            name: `tenant_${TEST_TENANT_ID}`,
          }),
        }),
      );
    });

    it("returns success with dispatched:false when node is offline", async () => {
      mockNodeConnections.sendCommand.mockRejectedValue(new Error("Node node-1 is not connected"));

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/wopr-plugin-discord`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config: { token: "abc" }, providerChoices: {} }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.dispatched).toBe(false);
      expect(body.dispatchError).toMatch(/not connected/);
    });

    it("skips dispatch when bot has no nodeId (not yet deployed)", async () => {
      mockDbChain.get.mockReturnValue({
        id: TEST_BOT_ID,
        tenantId: TEST_TENANT_ID,
        name: "test-bot",
        nodeId: null,
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/plugins/wopr-plugin-discord`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config: { token: "abc" }, providerChoices: {} }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.dispatched).toBe(false);
      expect(mockNodeConnections.sendCommand).not.toHaveBeenCalled();
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
      expect(mockNodeConnections.sendCommand).toHaveBeenCalledWith(
        TEST_NODE_ID,
        expect.objectContaining({ type: "bot.update" }),
      );
    });
  });
});
