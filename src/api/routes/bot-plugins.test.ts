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

const mockProfile = {
  id: TEST_BOT_ID,
  tenantId: "user-123",
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
      expect(storeMock.save).toHaveBeenCalledOnce();
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
      expect(body.plugins).toEqual(["plugin-a", "plugin-b"]);
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
});
