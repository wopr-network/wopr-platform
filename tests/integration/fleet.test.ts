/**
 * Integration tests for /fleet/* routes.
 *
 * Tests fleet endpoints through the full composed Hono app with real
 * middleware chains (bearer auth) but mocked Docker/FleetManager.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HEADER, JSON_HEADERS, fleetMock, pollerMock, updaterMock } from "./setup.js";

const { app } = await import("../../src/api/app.js");

describe("integration: fleet routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Authentication (middleware chain) ------------------------------------

  describe("auth middleware", () => {
    it("rejects unauthenticated requests to GET /fleet/bots", async () => {
      const res = await app.request("/fleet/bots");
      expect(res.status).toBe(401);
    });

    it("rejects wrong bearer token", async () => {
      const res = await app.request("/fleet/bots", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts valid bearer token", async () => {
      fleetMock.listAll.mockResolvedValue([]);
      const res = await app.request("/fleet/bots", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
    });
  });

  // -- GET /fleet/bots ------------------------------------------------------

  describe("GET /fleet/bots", () => {
    it("returns bot list", async () => {
      fleetMock.listAll.mockResolvedValue([
        { id: "bot-1", name: "alpha", state: "running" },
        { id: "bot-2", name: "bravo", state: "stopped" },
      ]);

      const res = await app.request("/fleet/bots", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bots).toHaveLength(2);
      expect(body.bots[0].name).toBe("alpha");
    });

    it("returns empty array when no bots exist", async () => {
      fleetMock.listAll.mockResolvedValue([]);

      const res = await app.request("/fleet/bots", { headers: AUTH_HEADER });
      const body = await res.json();
      expect(body.bots).toEqual([]);
    });
  });

  // -- POST /fleet/bots -----------------------------------------------------

  describe("POST /fleet/bots", () => {
    it("creates a bot with valid payload", async () => {
      fleetMock.create.mockResolvedValue({
        id: "new-bot",
        name: "test-bot",
        image: "ghcr.io/wopr-network/wopr:stable",
      });

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: JSON_HEADERS,
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

    it("returns 400 for invalid bot name", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: "!!bad!!", image: "test" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for host path in volumeName", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: "bot",
          image: "img",
          volumeName: "/var/run/docker.sock",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for path traversal in volumeName", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: "bot",
          image: "img",
          volumeName: "vol/../escape",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts valid named Docker volume", async () => {
      fleetMock.create.mockResolvedValue({
        id: "new-bot",
        name: "bot",
        image: "img",
        volumeName: "my-data-vol",
      });

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: "bot",
          image: "img",
          volumeName: "my-data-vol",
        }),
      });
      expect(res.status).toBe(201);
    });

    it("returns 400 for missing image", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: "good-name" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for malformed JSON", async () => {
      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "not json{{{",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 500 when fleet manager throws", async () => {
      fleetMock.create.mockRejectedValue(new Error("Docker daemon down"));

      const res = await app.request("/fleet/bots", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: "bot", image: "img" }),
      });
      expect(res.status).toBe(500);
    });
  });

  // -- GET /fleet/bots/:id --------------------------------------------------

  describe("GET /fleet/bots/:id", () => {
    it("returns bot status", async () => {
      fleetMock.status.mockResolvedValue({
        id: "bot-1",
        name: "alpha",
        state: "running",
        health: "healthy",
      });

      const res = await app.request("/fleet/bots/bot-1", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.state).toBe("running");
    });

    it("returns 404 for non-existent bot", async () => {
      const { BotNotFoundError } = await import("../../src/fleet/fleet-manager.js");
      fleetMock.status.mockRejectedValue(new BotNotFoundError("missing"));

      const res = await app.request("/fleet/bots/missing", { headers: AUTH_HEADER });
      expect(res.status).toBe(404);
    });
  });

  // -- PATCH /fleet/bots/:id ------------------------------------------------

  describe("PATCH /fleet/bots/:id", () => {
    it("updates bot config", async () => {
      fleetMock.update.mockResolvedValue({ id: "bot-1", name: "updated" });

      const res = await app.request("/fleet/bots/bot-1", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: "updated" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("updated");
    });

    it("returns 400 for host path in volumeName", async () => {
      const res = await app.request("/fleet/bots/bot-1", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ volumeName: "/etc" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty update body", async () => {
      const res = await app.request("/fleet/bots/bot-1", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for malformed JSON", async () => {
      const res = await app.request("/fleet/bots/bot-1", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: "{bad",
      });
      expect(res.status).toBe(400);
    });
  });

  // -- DELETE /fleet/bots/:id -----------------------------------------------

  describe("DELETE /fleet/bots/:id", () => {
    it("removes a bot (204 No Content)", async () => {
      fleetMock.remove.mockResolvedValue(undefined);

      const res = await app.request("/fleet/bots/bot-1", {
        method: "DELETE",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(204);
    });

    it("passes removeVolumes query parameter", async () => {
      fleetMock.remove.mockResolvedValue(undefined);

      await app.request("/fleet/bots/bot-1?removeVolumes=true", {
        method: "DELETE",
        headers: AUTH_HEADER,
      });
      expect(fleetMock.remove).toHaveBeenCalledWith("bot-1", true);
    });
  });

  // -- POST /fleet/bots/:id/start|stop|restart ------------------------------

  describe("lifecycle actions (start/stop/restart)", () => {
    it("POST /fleet/bots/:id/start starts a bot", async () => {
      fleetMock.start.mockResolvedValue(undefined);

      const res = await app.request("/fleet/bots/bot-1/start", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("POST /fleet/bots/:id/stop stops a bot", async () => {
      fleetMock.stop.mockResolvedValue(undefined);

      const res = await app.request("/fleet/bots/bot-1/stop", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
    });

    it("POST /fleet/bots/:id/restart restarts a bot", async () => {
      fleetMock.restart.mockResolvedValue(undefined);

      const res = await app.request("/fleet/bots/bot-1/restart", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
    });

    it("returns 404 when starting non-existent bot", async () => {
      const { BotNotFoundError } = await import("../../src/fleet/fleet-manager.js");
      fleetMock.start.mockRejectedValue(new BotNotFoundError("missing"));

      const res = await app.request("/fleet/bots/missing/start", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(404);
    });
  });

  // -- GET /fleet/bots/:id/logs ---------------------------------------------

  describe("GET /fleet/bots/:id/logs", () => {
    it("returns container logs as text", async () => {
      fleetMock.logs.mockResolvedValue("2026-01-01 startup complete");

      const res = await app.request("/fleet/bots/bot-1/logs", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("startup complete");
    });

    it("passes tail query parameter", async () => {
      fleetMock.logs.mockResolvedValue("logs");

      await app.request("/fleet/bots/bot-1/logs?tail=50", { headers: AUTH_HEADER });
      expect(fleetMock.logs).toHaveBeenCalledWith("bot-1", 50);
    });

    it("clamps tail to 10000 max", async () => {
      fleetMock.logs.mockResolvedValue("logs");

      await app.request("/fleet/bots/bot-1/logs?tail=99999", { headers: AUTH_HEADER });
      expect(fleetMock.logs).toHaveBeenCalledWith("bot-1", 10_000);
    });
  });

  // -- POST /fleet/bots/:id/update ------------------------------------------

  describe("POST /fleet/bots/:id/update", () => {
    it("returns success on successful update", async () => {
      updaterMock.updateBot.mockResolvedValue({
        botId: "bot-1",
        success: true,
        previousImage: "img:old",
        newImage: "img:new",
      });

      const res = await app.request("/fleet/bots/bot-1/update", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("returns 404 when bot not found during update", async () => {
      updaterMock.updateBot.mockResolvedValue({
        botId: "missing",
        success: false,
        error: "Bot not found",
      });

      const res = await app.request("/fleet/bots/missing/update", {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(404);
    });
  });

  // -- GET /fleet/bots/:id/image-status -------------------------------------

  describe("GET /fleet/bots/:id/image-status", () => {
    it("returns image status", async () => {
      fleetMock.profiles.get.mockResolvedValue({ id: "bot-1", image: "img" });
      pollerMock.getImageStatus.mockReturnValue({
        botId: "bot-1",
        updateAvailable: true,
        currentDigest: "sha256:old",
        availableDigest: "sha256:new",
      });

      const res = await app.request("/fleet/bots/bot-1/image-status", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updateAvailable).toBe(true);
    });

    it("returns 404 when bot profile not found", async () => {
      fleetMock.profiles.get.mockResolvedValue(null);

      const res = await app.request("/fleet/bots/missing/image-status", { headers: AUTH_HEADER });
      expect(res.status).toBe(404);
    });
  });
});
