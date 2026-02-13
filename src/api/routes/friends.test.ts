import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Set env var BEFORE importing friends routes so bearer auth uses this token
const TEST_TOKEN = "test-api-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };

// Mock the proxy module
const mockProxyToInstance = vi.fn();

vi.mock("./friends-proxy.js", () => ({
  proxyToInstance: (...args: unknown[]) => mockProxyToInstance(...args),
}));

// Import AFTER mocks are set up
const { friendsRoutes } = await import("./friends.js");

const app = new Hono();
app.route("/api/instances/:id/friends", friendsRoutes);

describe("friends routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authentication", () => {
    it("rejects requests without bearer token", async () => {
      const res = await app.request("/api/instances/bot-1/friends");
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await app.request("/api/instances/bot-1/friends", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("instance ID validation", () => {
    it("rejects invalid instance ID with special characters", async () => {
      mockProxyToInstance.mockResolvedValue({ ok: false, status: 400, error: "bad" });

      const res = await app.request("/api/instances/bot%20evil/friends", {
        headers: authHeader,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid instance ID");
    });
  });

  describe("GET /api/instances/:id/friends", () => {
    it("returns friends list from instance", async () => {
      const friends = [
        { peerId: "peer-1", name: "bot-a", status: "online", capabilities: ["message-only"] },
      ];
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { friends } });

      const res = await app.request("/api/instances/bot-1/friends", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.friends).toHaveLength(1);
      expect(mockProxyToInstance).toHaveBeenCalledWith("bot-1", "GET", "/p2p/friends");
    });

    it("returns 503 when instance is unavailable", async () => {
      mockProxyToInstance.mockResolvedValue({ ok: false, status: 503, error: "Instance unavailable" });

      const res = await app.request("/api/instances/bot-1/friends", { headers: authHeader });
      expect(res.status).toBe(503);
    });
  });

  describe("GET /api/instances/:id/friends/discovered", () => {
    it("returns discovered bots", async () => {
      const discovered = [{ peerId: "peer-2", name: "new-bot", topics: ["wopr-service"] }];
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { discovered } });

      const res = await app.request("/api/instances/bot-1/friends/discovered", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.discovered).toHaveLength(1);
      expect(mockProxyToInstance).toHaveBeenCalledWith("bot-1", "GET", "/p2p/discovered");
    });
  });

  describe("POST /api/instances/:id/friends/requests", () => {
    it("sends a friend request", async () => {
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 201, data: { ok: true, requestId: "req-1" } });

      const res = await app.request("/api/instances/bot-1/friends/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ peerId: "peer-2", message: "Hello!" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        "bot-1",
        "POST",
        "/p2p/friends/requests",
        { peerId: "peer-2", message: "Hello!" },
      );
    });

    it("rejects request with missing peerId", async () => {
      const res = await app.request("/api/instances/bot-1/friends/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Validation failed");
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/instances/bot-1/friends/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "not json{{{",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });
  });

  describe("GET /api/instances/:id/friends/requests", () => {
    it("lists pending friend requests", async () => {
      const requests = [{ id: "req-1", peerId: "peer-2", status: "pending" }];
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { requests } });

      const res = await app.request("/api/instances/bot-1/friends/requests", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.requests).toHaveLength(1);
    });
  });

  describe("POST /api/instances/:id/friends/requests/:reqId/accept", () => {
    it("accepts a friend request", async () => {
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });

      const res = await app.request("/api/instances/bot-1/friends/requests/req-1/accept", {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        "bot-1",
        "POST",
        "/p2p/friends/requests/req-1/accept",
      );
    });

    it("returns 404 when request not found", async () => {
      mockProxyToInstance.mockResolvedValue({ ok: false, status: 404, error: "Request not found" });

      const res = await app.request("/api/instances/bot-1/friends/requests/missing/accept", {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/instances/:id/friends/requests/:reqId/reject", () => {
    it("rejects a friend request", async () => {
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });

      const res = await app.request("/api/instances/bot-1/friends/requests/req-1/reject", {
        method: "POST",
        headers: authHeader,
      });

      expect(res.status).toBe(200);
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        "bot-1",
        "POST",
        "/p2p/friends/requests/req-1/reject",
      );
    });
  });

  describe("PATCH /api/instances/:id/friends/:friendId/capabilities", () => {
    it("updates friend capabilities", async () => {
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });

      const res = await app.request("/api/instances/bot-1/friends/friend-1/capabilities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ capabilities: ["message-only", "inject"] }),
      });

      expect(res.status).toBe(200);
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        "bot-1",
        "PATCH",
        "/p2p/friends/friend-1/capabilities",
        { capabilities: ["message-only", "inject"] },
      );
    });

    it("rejects empty capabilities array", async () => {
      const res = await app.request("/api/instances/bot-1/friends/friend-1/capabilities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ capabilities: [] }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid capability value", async () => {
      const res = await app.request("/api/instances/bot-1/friends/friend-1/capabilities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ capabilities: ["admin"] }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/instances/bot-1/friends/friend-1/capabilities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "bad json",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });
  });

  describe("GET /api/instances/:id/friends/auto-accept", () => {
    it("returns auto-accept rules", async () => {
      const rules = {
        enabled: true,
        sameTopicOnly: false,
        defaultCapabilities: ["message-only"],
        allowlist: [],
      };
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: rules });

      const res = await app.request("/api/instances/bot-1/friends/auto-accept", { headers: authHeader });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(mockProxyToInstance).toHaveBeenCalledWith("bot-1", "GET", "/p2p/friends/auto-accept");
    });
  });

  describe("PUT /api/instances/:id/friends/auto-accept", () => {
    it("updates auto-accept rules", async () => {
      const rules = {
        enabled: true,
        sameTopicOnly: true,
        defaultCapabilities: ["message-only"],
        allowlist: ["peer-trusted"],
      };
      mockProxyToInstance.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });

      const res = await app.request("/api/instances/bot-1/friends/auto-accept", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify(rules),
      });

      expect(res.status).toBe(200);
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        "bot-1",
        "PUT",
        "/p2p/friends/auto-accept",
        rules,
      );
    });

    it("rejects missing enabled field", async () => {
      const res = await app.request("/api/instances/bot-1/friends/auto-accept", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ sameTopicOnly: true }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/instances/bot-1/friends/auto-accept", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "not json",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("rejects invalid capability in defaultCapabilities", async () => {
      const res = await app.request("/api/instances/bot-1/friends/auto-accept", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          enabled: true,
          defaultCapabilities: ["root-access"],
        }),
      });

      expect(res.status).toBe(400);
    });
  });
});
