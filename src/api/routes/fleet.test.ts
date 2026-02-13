import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileTemplate } from "../../fleet/profile-schema.js";
import type { BotProfile, BotStatus } from "../../fleet/types.js";

// Set env var BEFORE importing fleet routes so bearer auth uses this token
const TEST_TOKEN = "test-api-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };

// --- Mock FleetManager ---

/** Stable UUIDs for test bots. */
const TEST_BOT_ID = "00000000-0000-4000-8000-000000000001";
/** A valid UUID for a bot that does not exist. */
const MISSING_BOT_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";

const mockProfile: BotProfile = {
  id: TEST_BOT_ID,
  name: "test-bot",
  description: "A test bot",
  image: "ghcr.io/wopr-network/wopr:stable",
  env: { TOKEN: "abc" },
  restartPolicy: "unless-stopped",
  releaseChannel: "stable",
  updatePolicy: "manual",
};

const mockStatus: BotStatus = {
  id: TEST_BOT_ID,
  name: "test-bot",
  description: "A test bot",
  image: "ghcr.io/wopr-network/wopr:stable",
  containerId: "container-123",
  state: "running",
  health: "healthy",
  uptime: "2026-01-01T00:00:00Z",
  startedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  stats: null,
};

class MockBotNotFoundError extends Error {
  constructor(id: string) {
    super(`Bot not found: ${id}`);
    this.name = "BotNotFoundError";
  }
}

const fleetMock = {
  create: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  remove: vi.fn(),
  status: vi.fn(),
  listAll: vi.fn(),
  logs: vi.fn(),
  update: vi.fn(),
  profiles: {
    get: vi.fn(),
  },
};

const updaterMock = {
  updateBot: vi.fn(),
};

const pollerMock = {
  getImageStatus: vi.fn(),
  onUpdateAvailable: null as ((botId: string, digest: string) => Promise<void>) | null,
};

// Mock the modules before importing fleet routes
vi.mock("dockerode", () => {
  return { default: class MockDocker {} };
});

vi.mock("../../fleet/profile-store.js", () => {
  return { ProfileStore: class MockProfileStore {} };
});

vi.mock("../../fleet/fleet-manager.js", () => {
  return {
    FleetManager: class {
      create = fleetMock.create;
      start = fleetMock.start;
      stop = fleetMock.stop;
      restart = fleetMock.restart;
      remove = fleetMock.remove;
      status = fleetMock.status;
      listAll = fleetMock.listAll;
      logs = fleetMock.logs;
      update = fleetMock.update;
      profiles = fleetMock.profiles;
    },
    BotNotFoundError: MockBotNotFoundError,
  };
});

vi.mock("../../fleet/image-poller.js", () => {
  return {
    ImagePoller: class {
      getImageStatus = pollerMock.getImageStatus;
      onUpdateAvailable = pollerMock.onUpdateAvailable;
    },
  };
});

vi.mock("../../fleet/updater.js", () => {
  return {
    ContainerUpdater: class {
      updateBot = updaterMock.updateBot;
    },
  };
});

// Import AFTER mocks are set up
const { fleetRoutes, seedBots } = await import("./fleet.js");

const app = new Hono();
app.route("/fleet", fleetRoutes);

describe("fleet routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authentication", () => {
    it("rejects requests without bearer token", async () => {
      const res = await app.request("/fleet/bots");
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await app.request("/fleet/bots", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /fleet/bots", () => {
    it("returns list of bots", async () => {
      fleetMock.listAll.mockResolvedValue([mockStatus]);

      const res = await app.request("/fleet/bots", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bots).toHaveLength(1);
      expect(body.bots[0].name).toBe("test-bot");
    });

    it("returns empty list when no bots", async () => {
      fleetMock.listAll.mockResolvedValue([]);

      const res = await app.request("/fleet/bots", { headers: authHeader });
      const body = await res.json();
      expect(body.bots).toEqual([]);
    });
  });

  describe("POST /fleet/bots", () => {
    it("creates a bot with valid input", async () => {
      fleetMock.create.mockResolvedValue(mockProfile);

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          name: "test-bot",
          image: "ghcr.io/wopr-network/wopr:stable",
          env: { TOKEN: "abc" },
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("test-bot");
    });

    it("rejects invalid name", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ name: "!!invalid!!", image: "test" }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects missing image", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ name: "valid-bot" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 on malformed JSON body", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "not json{{{",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 500 on fleet manager error", async () => {
      fleetMock.create.mockRejectedValue(new Error("Docker down"));

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ name: "bot", image: "img" }),
      });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /fleet/bots/:id", () => {
    it("returns bot status", async () => {
      fleetMock.status.mockResolvedValue(mockStatus);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.state).toBe("running");
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.status.mockRejectedValue(new MockBotNotFoundError(MISSING_BOT_ID));

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}`, { headers: authHeader });
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /fleet/bots/:id", () => {
    it("updates bot config", async () => {
      fleetMock.update.mockResolvedValue({ ...mockProfile, name: "updated-bot" });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ name: "updated-bot" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("updated-bot");
    });

    it("rejects empty update", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 on malformed JSON body", async () => {
      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "{bad json",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.update.mockRejectedValue(new MockBotNotFoundError(MISSING_BOT_ID));

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ name: "new-name" }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /fleet/bots/:id", () => {
    it("removes a bot", async () => {
      fleetMock.remove.mockResolvedValue(undefined);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}`, { method: "DELETE", headers: authHeader });
      expect(res.status).toBe(204);
    });

    it("passes removeVolumes query param", async () => {
      fleetMock.remove.mockResolvedValue(undefined);

      await app.request(`/fleet/bots/${TEST_BOT_ID}?removeVolumes=true`, { method: "DELETE", headers: authHeader });
      expect(fleetMock.remove).toHaveBeenCalledWith(TEST_BOT_ID, true);
    });
  });

  describe("POST /fleet/bots/:id/start", () => {
    it("starts a bot", async () => {
      fleetMock.start.mockResolvedValue(undefined);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/start`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.start.mockRejectedValue(new MockBotNotFoundError(MISSING_BOT_ID));

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/start`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /fleet/bots/:id/stop", () => {
    it("stops a bot", async () => {
      fleetMock.stop.mockResolvedValue(undefined);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/stop`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /fleet/bots/:id/restart", () => {
    it("restarts a bot", async () => {
      fleetMock.restart.mockResolvedValue(undefined);

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/restart`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /fleet/bots/:id/update", () => {
    it("triggers force update and returns result", async () => {
      updaterMock.updateBot.mockResolvedValue({
        botId: TEST_BOT_ID,
        success: true,
        previousImage: "ghcr.io/wopr-network/wopr:stable",
        newImage: "ghcr.io/wopr-network/wopr:stable",
        previousDigest: "sha256:old",
        newDigest: "sha256:new",
        rolledBack: false,
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/update`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(updaterMock.updateBot).toHaveBeenCalledWith(TEST_BOT_ID);
    });

    it("returns 404 when bot not found", async () => {
      updaterMock.updateBot.mockResolvedValue({
        botId: MISSING_BOT_ID,
        success: false,
        previousImage: "",
        newImage: "",
        previousDigest: null,
        newDigest: null,
        rolledBack: false,
        error: "Bot not found",
      });

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/update`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(404);
    });

    it("returns 500 on update failure", async () => {
      updaterMock.updateBot.mockResolvedValue({
        botId: TEST_BOT_ID,
        success: false,
        previousImage: "ghcr.io/wopr-network/wopr:stable",
        newImage: "ghcr.io/wopr-network/wopr:stable",
        previousDigest: null,
        newDigest: null,
        rolledBack: true,
        error: "Health check failed",
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/update`, { method: "POST", headers: authHeader });
      expect(res.status).toBe(500);
    });
  });

  describe("GET /fleet/bots/:id/image-status", () => {
    it("returns image status for tracked bot", async () => {
      fleetMock.profiles.get.mockResolvedValue(mockProfile);
      pollerMock.getImageStatus.mockReturnValue({
        botId: TEST_BOT_ID,
        currentDigest: "sha256:abc",
        availableDigest: "sha256:def",
        updateAvailable: true,
        releaseChannel: "stable",
        updatePolicy: "manual",
        lastCheckedAt: "2026-01-01T00:00:00Z",
      });

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/image-status`, { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updateAvailable).toBe(true);
      expect(body.currentDigest).toBe("sha256:abc");
      expect(body.availableDigest).toBe("sha256:def");
    });

    it("returns 404 when bot not found", async () => {
      fleetMock.profiles.get.mockResolvedValue(null);

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/image-status`, { headers: authHeader });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /fleet/bots/:id/logs", () => {
    it("returns container logs", async () => {
      fleetMock.logs.mockResolvedValue("2026-01-01 log line");

      const res = await app.request(`/fleet/bots/${TEST_BOT_ID}/logs`, { headers: authHeader });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("log line");
    });

    it("passes tail parameter", async () => {
      fleetMock.logs.mockResolvedValue("logs");

      await app.request(`/fleet/bots/${TEST_BOT_ID}/logs?tail=50`, { headers: authHeader });
      expect(fleetMock.logs).toHaveBeenCalledWith(TEST_BOT_ID, 50);
    });

    it("clamps tail to upper bound of 10000", async () => {
      fleetMock.logs.mockResolvedValue("logs");

      await app.request(`/fleet/bots/${TEST_BOT_ID}/logs?tail=99999`, { headers: authHeader });
      expect(fleetMock.logs).toHaveBeenCalledWith(TEST_BOT_ID, 10_000);
    });

    it("defaults negative tail to 100", async () => {
      fleetMock.logs.mockResolvedValue("logs");

      await app.request(`/fleet/bots/${TEST_BOT_ID}/logs?tail=-5`, { headers: authHeader });
      expect(fleetMock.logs).toHaveBeenCalledWith(TEST_BOT_ID, 100);
    });

    it("defaults tail=0 to 100", async () => {
      fleetMock.logs.mockResolvedValue("logs");

      await app.request(`/fleet/bots/${TEST_BOT_ID}/logs?tail=0`, { headers: authHeader });
      expect(fleetMock.logs).toHaveBeenCalledWith(TEST_BOT_ID, 100);
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.logs.mockRejectedValue(new MockBotNotFoundError(MISSING_BOT_ID));

      const res = await app.request(`/fleet/bots/${MISSING_BOT_ID}/logs`, { headers: authHeader });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /fleet/seed", () => {
    let origEnv: string | undefined;

    beforeEach(() => {
      origEnv = process.env.FLEET_TEMPLATES_DIR;
    });

    afterEach(() => {
      if (origEnv === undefined) {
        delete process.env.FLEET_TEMPLATES_DIR;
      } else {
        process.env.FLEET_TEMPLATES_DIR = origEnv;
      }
    });

    it("returns 200 with created bots when templates exist", async () => {
      process.env.FLEET_TEMPLATES_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "templates");
      const res = await app.request("/fleet/seed", { method: "POST", headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("created");
      expect(body).toHaveProperty("skipped");
      expect(Array.isArray(body.created)).toBe(true);
    });

    it("returns 404 when templates directory is empty", async () => {
      process.env.FLEET_TEMPLATES_DIR = path.resolve(import.meta.dirname);
      const res = await app.request("/fleet/seed", { method: "POST", headers: authHeader });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });
  });
});

describe("seedBots", () => {
  const makeTemplate = (name: string): ProfileTemplate => ({
    name,
    description: `Bot ${name}`,
    channel: { plugin: "test-channel", config: {} },
    provider: { plugin: "test-provider", config: {} },
    release: "stable",
    image: "ghcr.io/test:stable",
    restartPolicy: "unless-stopped",
    healthCheck: { endpoint: "/health", intervalSeconds: 30, timeoutSeconds: 5, retries: 3 },
    volumes: [],
    env: {},
  });

  it("creates all bots when none exist", () => {
    const templates = [makeTemplate("bot-a"), makeTemplate("bot-b")];
    const existing = new Set<string>();
    const result = seedBots(templates, existing);

    expect(result.created).toEqual(["bot-a", "bot-b"]);
    expect(result.skipped).toEqual([]);
  });

  it("skips bots that already exist", () => {
    const templates = [makeTemplate("bot-a"), makeTemplate("bot-b")];
    const existing = new Set(["bot-a"]);
    const result = seedBots(templates, existing);

    expect(result.created).toEqual(["bot-b"]);
    expect(result.skipped).toEqual(["bot-a"]);
  });

  it("skips all when all exist", () => {
    const templates = [makeTemplate("bot-a"), makeTemplate("bot-b")];
    const existing = new Set(["bot-a", "bot-b"]);
    const result = seedBots(templates, existing);

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(["bot-a", "bot-b"]);
  });

  it("handles empty template list", () => {
    const result = seedBots([], new Set());
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("adds created bots to existing set", () => {
    const templates = [makeTemplate("new-bot")];
    const existing = new Set<string>();
    seedBots(templates, existing);

    expect(existing.has("new-bot")).toBe(true);
  });
});
