import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Operator token (no tenant scope — bypasses ownership checks)
const TEST_TOKEN = "test-proxy-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);

// Tenant-scoped token for ownership tests
const TENANT_TOKEN = "tenant-scoped-proxy-token";
vi.stubEnv("FLEET_TOKEN_user-456", `write:${TENANT_TOKEN}`);

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };
const tenantAuthHeader = { Authorization: `Bearer ${TENANT_TOKEN}` };
const TEST_BOT_ID = "00000000-0000-4000-8000-000000000001";
const MISSING_BOT_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const TEST_TENANT_ID = "user-456";

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

const storeMock = { get: vi.fn() };

vi.mock("../../fleet/bot-profile-repository.js", () => ({}));

const proxyMock = vi.fn();
vi.mock("./friends-proxy.js", () => ({
  proxyToInstance: (...args: unknown[]) => proxyMock(...args),
}));

const pluginConfigRepoMock = {
  findAllForBot: vi.fn().mockResolvedValue([]),
  findByBotAndPlugin: vi.fn(),
  upsert: vi.fn(),
  deleteBySetupSession: vi.fn(),
  deleteByBotAndPlugin: vi.fn(),
};

const { createBotPluginProxyRoutes } = await import("./bot-plugin-proxy.js");

const profileRepoMock = { get: storeMock.get, save: vi.fn(), delete: vi.fn(), list: vi.fn() };
const routes = createBotPluginProxyRoutes({ pluginConfigRepo: pluginConfigRepoMock, profileRepo: profileRepoMock });
const app = new Hono();
app.route("/api/bots", routes);

describe("bot-plugin-proxy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.get.mockImplementation((id: string) =>
      id === TEST_BOT_ID ? Promise.resolve({ ...mockProfile }) : Promise.resolve(null),
    );
    proxyMock.mockResolvedValue({ ok: true, status: 200, data: { success: true } });
    pluginConfigRepoMock.findByBotAndPlugin.mockResolvedValue(null);
    pluginConfigRepoMock.upsert.mockResolvedValue({});
  });

  describe("POST /api/bots/:botId/plugins/install", () => {
    it("proxies install to daemon and returns 200", async () => {
      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ pluginId: "wopr-plugin-discord" }),
      });

      expect(res.status).toBe(200);
      expect(proxyMock).toHaveBeenCalledWith(TEST_BOT_ID, "POST", "/plugins/install", {
        source: "wopr-plugin-discord",
      });
    });

    it("forwards stored config after successful install", async () => {
      pluginConfigRepoMock.findByBotAndPlugin.mockResolvedValue({
        configJson: JSON.stringify({ token: "abc123" }),
      });

      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ pluginId: "wopr-plugin-discord" }),
      });

      expect(res.status).toBe(200);
      // First call: install, second call: config push
      expect(proxyMock).toHaveBeenCalledTimes(2);
      expect(proxyMock).toHaveBeenNthCalledWith(2, TEST_BOT_ID, "PUT", "/plugins/wopr-plugin-discord/config", {
        config: { token: "abc123" },
      });
    });

    it("returns 403/404 when user does not own bot (tenant-scoped token)", async () => {
      // Use a tenant-scoped token for user-456, but bot belongs to other-tenant
      storeMock.get.mockResolvedValue({
        ...mockProfile,
        tenantId: "other-tenant",
      });

      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...tenantAuthHeader },
        body: JSON.stringify({ pluginId: "wopr-plugin-discord" }),
      });

      // validateTenantOwnership returns 404 when tenantId mismatches (resource not found)
      expect(res.status).toBe(404);
      expect(proxyMock).not.toHaveBeenCalled();
    });

    it("returns 503 when daemon is offline", async () => {
      proxyMock.mockResolvedValue({ ok: false, status: 503, error: "Instance unavailable" });

      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ pluginId: "wopr-plugin-discord" }),
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toMatch(/unavailable/i);
    });

    it("returns daemon error payload on install failure", async () => {
      proxyMock.mockResolvedValue({
        ok: false,
        status: 404,
        error: "Package not found: wopr-plugin-fake",
      });

      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ pluginId: "wopr-plugin-fake" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/Package not found/);
    });

    it("returns 404 for non-existent bot", async () => {
      const res = await app.request(`/api/bots/${MISSING_BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ pluginId: "wopr-plugin-discord" }),
      });

      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid botId", async () => {
      const res = await app.request("/api/bots/not-a-uuid/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ pluginId: "test" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for missing pluginId in body", async () => {
      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for pluginId with invalid characters (path injection attempt)", async () => {
      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ pluginId: "../../../etc/passwd" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for pluginId starting with a hyphen", async () => {
      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ pluginId: "-bad-plugin" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 401 without auth token", async () => {
      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: "test" }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("PUT /api/bots/:botId/plugins/:pluginId/config — tenant isolation", () => {
    it("returns 404 when user does not own bot (tenant-scoped token)", async () => {
      storeMock.get.mockResolvedValue({ ...mockProfile, tenantId: "other-tenant" });

      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/my-plugin/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...tenantAuthHeader },
        body: JSON.stringify({ config: { key: "value" } }),
      });

      expect(res.status).toBe(404);
      expect(pluginConfigRepoMock.upsert).not.toHaveBeenCalled();
      expect(proxyMock).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/bots/:botId/plugins/:pluginId/enable — tenant isolation", () => {
    it("returns 404 when user does not own bot (tenant-scoped token)", async () => {
      storeMock.get.mockResolvedValue({ ...mockProfile, tenantId: "other-tenant" });

      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/my-plugin/enable`, {
        method: "POST",
        headers: tenantAuthHeader,
      });

      expect(res.status).toBe(404);
      expect(proxyMock).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/bots/:botId/plugins/:pluginId/disable — tenant isolation", () => {
    it("returns 404 when user does not own bot (tenant-scoped token)", async () => {
      storeMock.get.mockResolvedValue({ ...mockProfile, tenantId: "other-tenant" });

      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/my-plugin/disable`, {
        method: "POST",
        headers: tenantAuthHeader,
      });

      expect(res.status).toBe(404);
      expect(proxyMock).not.toHaveBeenCalled();
    });
  });

  describe("PUT /api/bots/:botId/plugins/:pluginId/config", () => {
    it("upserts config to DB and proxies to daemon", async () => {
      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/my-plugin/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config: { key: "value" } }),
      });

      expect(res.status).toBe(200);
      expect(pluginConfigRepoMock.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: TEST_BOT_ID,
          pluginId: "my-plugin",
          configJson: JSON.stringify({ key: "value" }),
        }),
      );
      expect(proxyMock).toHaveBeenCalledWith(TEST_BOT_ID, "PUT", "/plugins/my-plugin/config", {
        config: { key: "value" },
      });
    });

    it("returns 200 with configSaved=true and daemonUpdated=false when daemon offline but config is still saved", async () => {
      proxyMock.mockResolvedValue({ ok: false, status: 503, error: "Instance unavailable" });

      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/my-plugin/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ config: { key: "value" } }),
      });

      expect(res.status).toBe(200);
      // Config should still be saved to DB
      expect(pluginConfigRepoMock.upsert).toHaveBeenCalled();
      const body = await res.json();
      expect(body.configSaved).toBe(true);
      expect(body.daemonUpdated).toBe(false);
    });
  });

  describe("POST /api/bots/:botId/plugins/:pluginId/enable", () => {
    it("proxies enable to daemon", async () => {
      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/my-plugin/enable`, {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      expect(proxyMock).toHaveBeenCalledWith(TEST_BOT_ID, "POST", "/plugins/my-plugin/enable");
    });
  });

  describe("POST /api/bots/:botId/plugins/:pluginId/disable", () => {
    it("proxies disable to daemon", async () => {
      const res = await app.request(`/api/bots/${TEST_BOT_ID}/plugins/my-plugin/disable`, {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      expect(proxyMock).toHaveBeenCalledWith(TEST_BOT_ID, "POST", "/plugins/my-plugin/disable");
    });
  });
});
