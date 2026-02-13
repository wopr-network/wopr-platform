import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileTemplate } from "../../fleet/profile-schema.js";
import type { BotProfile, BotStatus } from "../../fleet/types.js";

// --- Mock FleetManager ---

const mockProfile: BotProfile = {
  id: "test-uuid",
  name: "test-bot",
  description: "A test bot",
  image: "ghcr.io/wopr-network/wopr:stable",
  env: { TOKEN: "abc" },
  restartPolicy: "unless-stopped",
};

const mockStatus: BotStatus = {
  id: "test-uuid",
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
    },
    BotNotFoundError: MockBotNotFoundError,
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

  describe("GET /fleet/bots", () => {
    it("returns list of bots", async () => {
      fleetMock.listAll.mockResolvedValue([mockStatus]);

      const res = await app.request("/fleet/bots");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bots).toHaveLength(1);
      expect(body.bots[0].name).toBe("test-bot");
    });

    it("returns empty list when no bots", async () => {
      fleetMock.listAll.mockResolvedValue([]);

      const res = await app.request("/fleet/bots");
      const body = await res.json();
      expect(body.bots).toEqual([]);
    });
  });

  describe("POST /fleet/bots", () => {
    it("creates a bot with valid input", async () => {
      fleetMock.create.mockResolvedValue(mockProfile);

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "!!invalid!!", image: "test" }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects missing image", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "valid-bot" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 500 on fleet manager error", async () => {
      fleetMock.create.mockRejectedValue(new Error("Docker down"));

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bot", image: "img" }),
      });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /fleet/bots/:id", () => {
    it("returns bot status", async () => {
      fleetMock.status.mockResolvedValue(mockStatus);

      const res = await app.request("/fleet/bots/test-uuid");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.state).toBe("running");
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.status.mockRejectedValue(new MockBotNotFoundError("missing"));

      const res = await app.request("/fleet/bots/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /fleet/bots/:id", () => {
    it("updates bot config", async () => {
      fleetMock.update.mockResolvedValue({ ...mockProfile, name: "updated-bot" });

      const res = await app.request("/fleet/bots/test-uuid", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "updated-bot" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("updated-bot");
    });

    it("rejects empty update", async () => {
      const res = await app.request("/fleet/bots/test-uuid", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.update.mockRejectedValue(new MockBotNotFoundError("missing"));

      const res = await app.request("/fleet/bots/missing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "new-name" }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /fleet/bots/:id", () => {
    it("removes a bot", async () => {
      fleetMock.remove.mockResolvedValue(undefined);

      const res = await app.request("/fleet/bots/test-uuid", { method: "DELETE" });
      expect(res.status).toBe(204);
    });

    it("passes removeVolumes query param", async () => {
      fleetMock.remove.mockResolvedValue(undefined);

      await app.request("/fleet/bots/test-uuid?removeVolumes=true", { method: "DELETE" });
      expect(fleetMock.remove).toHaveBeenCalledWith("test-uuid", true);
    });
  });

  describe("POST /fleet/bots/:id/start", () => {
    it("starts a bot", async () => {
      fleetMock.start.mockResolvedValue(undefined);

      const res = await app.request("/fleet/bots/test-uuid/start", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.start.mockRejectedValue(new MockBotNotFoundError("missing"));

      const res = await app.request("/fleet/bots/missing/start", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /fleet/bots/:id/stop", () => {
    it("stops a bot", async () => {
      fleetMock.stop.mockResolvedValue(undefined);

      const res = await app.request("/fleet/bots/test-uuid/stop", { method: "POST" });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /fleet/bots/:id/restart", () => {
    it("restarts a bot", async () => {
      fleetMock.restart.mockResolvedValue(undefined);

      const res = await app.request("/fleet/bots/test-uuid/restart", { method: "POST" });
      expect(res.status).toBe(200);
    });
  });

  describe("GET /fleet/bots/:id/logs", () => {
    it("returns container logs", async () => {
      fleetMock.logs.mockResolvedValue("2026-01-01 log line");

      const res = await app.request("/fleet/bots/test-uuid/logs");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("log line");
    });

    it("passes tail parameter", async () => {
      fleetMock.logs.mockResolvedValue("logs");

      await app.request("/fleet/bots/test-uuid/logs?tail=50");
      expect(fleetMock.logs).toHaveBeenCalledWith("test-uuid", 50);
    });

    it("returns 404 for missing bot", async () => {
      fleetMock.logs.mockRejectedValue(new MockBotNotFoundError("missing"));

      const res = await app.request("/fleet/bots/missing/logs");
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
      const res = await app.request("/fleet/seed", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("created");
      expect(body).toHaveProperty("skipped");
      expect(Array.isArray(body.created)).toBe(true);
    });

    it("returns 404 when templates directory is empty", async () => {
      process.env.FLEET_TEMPLATES_DIR = path.resolve(import.meta.dirname);
      const res = await app.request("/fleet/seed", { method: "POST" });
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
