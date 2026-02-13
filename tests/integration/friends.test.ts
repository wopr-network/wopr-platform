/**
 * Integration tests for /api/instances/:id/friends/* routes.
 *
 * Tests friend management endpoints through the full composed Hono app.
 * The proxy to bot instances is mocked since containers aren't available.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HEADER, JSON_HEADERS, mockProxyToInstance } from "./setup.js";

const { app } = await import("../../src/api/app.js");

describe("integration: friends routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Authentication -------------------------------------------------------

  describe("auth middleware", () => {
    it("rejects requests without token", async () => {
      const res = await app.request("/api/instances/bot-1/friends");
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await app.request("/api/instances/bot-1/friends", {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    });
  });

  // -- Instance ID validation -----------------------------------------------

  describe("instance ID validation", () => {
    it("rejects invalid instance ID with special characters", async () => {
      const res = await app.request("/api/instances/bot%20evil/friends", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid instance ID");
    });
  });

  // -- GET /api/instances/:id/friends ---------------------------------------

  describe("GET /api/instances/:id/friends", () => {
    it("returns friends list from instance", async () => {
      const friends = [{ peerId: "peer-1", name: "bot-a", capabilities: ["message-only"] }];
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { friends } });

      const res = await app.request("/api/instances/bot-1/friends", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.friends).toHaveLength(1);
      expect(mockProxyToInstance).toHaveBeenCalledWith("bot-1", "GET", "/p2p/friends");
    });

    it("returns 503 when instance is unavailable", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: false,
        status: 503,
        error: "Instance unavailable",
      });

      const res = await app.request("/api/instances/bot-1/friends", { headers: AUTH_HEADER });
      expect(res.status).toBe(503);
    });
  });

  // -- GET /api/instances/:id/friends/discovered ----------------------------

  describe("GET /api/instances/:id/friends/discovered", () => {
    it("returns discovered bots", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: true,
        status: 200,
        data: { discovered: [{ peerId: "peer-2" }] },
      });

      const res = await app.request("/api/instances/bot-1/friends/discovered", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.discovered).toHaveLength(1);
    });
  });

  // -- POST /api/instances/:id/friends/requests -----------------------------

  describe("POST /api/instances/:id/friends/requests", () => {
    it("sends a friend request", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: true,
        status: 201,
        data: { ok: true, requestId: "req-1" },
      });

      const res = await app.request("/api/instances/bot-1/friends/requests", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ peerId: "peer-2", message: "Hello!" }),
      });

      expect(res.status).toBe(201);
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        "bot-1",
        "POST",
        "/p2p/friends/requests",
        { peerId: "peer-2", message: "Hello!" },
      );
    });

    it("returns 400 for missing peerId", async () => {
      const res = await app.request("/api/instances/bot-1/friends/requests", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for malformed JSON", async () => {
      const res = await app.request("/api/instances/bot-1/friends/requests", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "not json{{{",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });
  });

  // -- POST /api/instances/:id/friends/requests/:reqId/accept ---------------

  describe("POST .../requests/:reqId/accept", () => {
    it("accepts a friend request", async () => {
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });

      const res = await app.request("/api/instances/bot-1/friends/requests/req-1/accept", {
        method: "POST",
        headers: AUTH_HEADER,
      });

      expect(res.status).toBe(200);
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        "bot-1",
        "POST",
        "/p2p/friends/requests/req-1/accept",
      );
    });
  });

  // -- POST /api/instances/:id/friends/requests/:reqId/reject ---------------

  describe("POST .../requests/:reqId/reject", () => {
    it("rejects a friend request", async () => {
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });

      const res = await app.request("/api/instances/bot-1/friends/requests/req-1/reject", {
        method: "POST",
        headers: AUTH_HEADER,
      });

      expect(res.status).toBe(200);
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        "bot-1",
        "POST",
        "/p2p/friends/requests/req-1/reject",
      );
    });
  });

  // -- PATCH /api/instances/:id/friends/:friendId/capabilities ---------------

  describe("PATCH .../:friendId/capabilities", () => {
    it("updates friend capabilities", async () => {
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });

      const res = await app.request("/api/instances/bot-1/friends/friend-1/capabilities", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ capabilities: ["message-only", "inject"] }),
      });

      expect(res.status).toBe(200);
    });

    it("returns 400 for empty capabilities array", async () => {
      const res = await app.request("/api/instances/bot-1/friends/friend-1/capabilities", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ capabilities: [] }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid capability value", async () => {
      const res = await app.request("/api/instances/bot-1/friends/friend-1/capabilities", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ capabilities: ["admin"] }),
      });
      expect(res.status).toBe(400);
    });
  });

  // -- GET /api/instances/:id/friends/auto-accept ---------------------------

  describe("GET .../auto-accept", () => {
    it("returns auto-accept rules", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: true,
        status: 200,
        data: { enabled: true, sameTopicOnly: false, defaultCapabilities: ["message-only"] },
      });

      const res = await app.request("/api/instances/bot-1/friends/auto-accept", {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(true);
    });
  });

  // -- PUT /api/instances/:id/friends/auto-accept ---------------------------

  describe("PUT .../auto-accept", () => {
    it("updates auto-accept rules", async () => {
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });

      const rules = {
        enabled: true,
        sameTopicOnly: true,
        defaultCapabilities: ["message-only"],
        allowlist: ["peer-trusted"],
      };

      const res = await app.request("/api/instances/bot-1/friends/auto-accept", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify(rules),
      });

      expect(res.status).toBe(200);
    });

    it("returns 400 for missing enabled field", async () => {
      const res = await app.request("/api/instances/bot-1/friends/auto-accept", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ sameTopicOnly: true }),
      });
      expect(res.status).toBe(400);
    });
  });
});
