/**
 * E2E: Friends/social lifecycle — send request → accept → verify bidirectional
 * friendship → proxy interactions → edge cases (WOP-1699).
 *
 * Mounts real Hono friendsRoutes with real auth middleware. The bot instance
 * P2P proxy is mocked so no containers are needed. Pattern follows
 * tests/e2e/tenant-isolation.e2e.test.ts.
 */
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Env stubs MUST be set before any route module imports
// ---------------------------------------------------------------------------

const TEST_TOKEN = "e2e-friends-test-token";
vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);

// Tenant-scoped token for cross-tenant isolation tests
const TENANT_ID = "e2e-tenant";
const TENANT_TOKEN = "e2e-tenant-scoped-token";
vi.stubEnv(`FLEET_TOKEN_${TENANT_ID}`, `read:${TENANT_TOKEN}`);
const OTHER_TENANT_ID = "other-tenant";
const OTHER_TENANT_TOKEN = "e2e-other-tenant-token";
vi.stubEnv(`FLEET_TOKEN_${OTHER_TENANT_ID}`, `read:${OTHER_TENANT_TOKEN}`);

vi.mock("@wopr-network/platform-core/config/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockProxyToInstance = vi.fn();

vi.mock("../../src/api/routes/friends-proxy.js", () => ({
  proxyToInstance: (...args: unknown[]) => mockProxyToInstance(...args),
}));

vi.mock("@wopr-network/platform-core/fleet/profile-store", () => ({
  ProfileStore: class MockProfileStore {
    get = vi.fn().mockResolvedValue({ tenantId: "e2e-tenant" });
  },
}));

// Dynamic import AFTER mocks are set up
const { friendsRoutes } = await import("../../src/api/routes/friends.js");

const app = new Hono();
app.route("/api/instances/:id/friends", friendsRoutes);

const authHeader = { Authorization: `Bearer ${TEST_TOKEN}` };
const jsonAuth = { "Content-Type": "application/json", ...authHeader };

const ALICE = "bot-alice";
const BOB = "bot-bob";

// ---------------------------------------------------------------------------
// E2E: friends/social lifecycle
// ---------------------------------------------------------------------------

describe("E2E: friends/social lifecycle", () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Auth checks
  // -------------------------------------------------------------------------

  describe("auth checks", () => {
    it("unauthenticated request returns 401", async () => {
      const res = await app.request(`/api/instances/${ALICE}/friends`, {});
      expect(res.status).toBe(401);
    });

    it("cross-tenant access returns 403 or 404", async () => {
      // OTHER_TENANT_TOKEN belongs to "other-tenant"; instances belong to "e2e-tenant"
      const res = await app.request(`/api/instances/${ALICE}/friends`, {
        headers: { Authorization: `Bearer ${OTHER_TENANT_TOKEN}` },
      });
      expect([403, 404]).toContain(res.status);
    });

    it("tenant-scoped token matching instance tenant passes validateTenantOwnership", async () => {
      // TENANT_TOKEN is scoped to "e2e-tenant" — same as the instance's tenantId.
      // This exercises the validateTenantOwnership() happy path (not operator bypass).
      mockProxyToInstance.mockResolvedValue({
        ok: true,
        status: 200,
        data: { friends: [] },
      });

      const res = await app.request(`/api/instances/${ALICE}/friends`, {
        headers: { Authorization: `Bearer ${TENANT_TOKEN}` },
      });
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Friend request flow
  // -------------------------------------------------------------------------

  describe("friend request flow", () => {
    it("User A sends friend request to User B", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: true,
        status: 201,
        data: { ok: true, requestId: "req-alice-bob-1" },
      });

      const res = await app.request(`/api/instances/${ALICE}/friends/requests`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ peerId: "peer-bob", message: "Hey Bob!" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.requestId).toBe("req-alice-bob-1");
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        ALICE,
        "POST",
        "/p2p/friends/requests",
        { peerId: "peer-bob", message: "Hey Bob!" },
      );
    });

    it("User B accepts friend request from User A", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: true,
        status: 200,
        data: { ok: true },
      });

      const res = await app.request(
        `/api/instances/${BOB}/friends/requests/req-alice-bob-1/accept`,
        { method: "POST", headers: authHeader },
      );

      expect(res.status).toBe(200);
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        BOB,
        "POST",
        "/p2p/friends/requests/req-alice-bob-1/accept",
      );
    });

    it("friendship is bidirectional — both instances list each other", async () => {
      mockProxyToInstance.mockImplementation(async (instanceId: string) => {
        if (instanceId === ALICE) {
          return {
            ok: true,
            status: 200,
            data: {
              friends: [{ peerId: "peer-bob", name: "bot-bob", capabilities: ["message-only"] }],
            },
          };
        }
        if (instanceId === BOB) {
          return {
            ok: true,
            status: 200,
            data: {
              friends: [{ peerId: "peer-alice", name: "bot-alice", capabilities: ["message-only"] }],
            },
          };
        }
        return { ok: false, status: 404, error: "Unknown instance" };
      });

      const aliceRes = await app.request(`/api/instances/${ALICE}/friends`, {
        headers: authHeader,
      });
      expect(aliceRes.status).toBe(200);
      const aliceBody = (await aliceRes.json()) as { friends: Array<{ peerId: string }> };
      expect(aliceBody.friends).toHaveLength(1);
      expect(aliceBody.friends[0].peerId).toBe("peer-bob");

      const bobRes = await app.request(`/api/instances/${BOB}/friends`, {
        headers: authHeader,
      });
      expect(bobRes.status).toBe(200);
      const bobBody = (await bobRes.json()) as { friends: Array<{ peerId: string }> };
      expect(bobBody.friends).toHaveLength(1);
      expect(bobBody.friends[0].peerId).toBe("peer-alice");
    });

    it("friend proxy: update capabilities for a friend", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: true,
        status: 200,
        data: { ok: true },
      });

      const res = await app.request(
        `/api/instances/${ALICE}/friends/peer-bob/capabilities`,
        {
          method: "PATCH",
          headers: jsonAuth,
          body: JSON.stringify({ capabilities: ["message-only", "inject"] }),
        },
      );

      expect(res.status).toBe(200);
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        ALICE,
        "PATCH",
        "/p2p/friends/peer-bob/capabilities",
        { capabilities: ["message-only", "inject"] },
      );
    });

    it.todo("User A unfriends User B — verify cleanup (no DELETE /friends/:id route yet)");
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("duplicate friend request is idempotent", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: true,
        status: 200,
        data: { ok: true, requestId: "req-alice-bob-1", duplicate: true },
      });

      const res = await app.request(`/api/instances/${ALICE}/friends/requests`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ peerId: "peer-bob" }),
      });

      // Instance returns 200 (not 409) for duplicate — idempotent
      expect(res.status).toBe(200);
    });

    it("rejecting friend request returns 200 from instance", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: true,
        status: 200,
        data: { ok: true },
      });

      const res = await app.request(
        `/api/instances/${BOB}/friends/requests/req-charlie-bob-1/reject`,
        { method: "POST", headers: authHeader },
      );

      expect(res.status).toBe(200);
      expect(mockProxyToInstance).toHaveBeenCalledWith(
        BOB,
        "POST",
        "/p2p/friends/requests/req-charlie-bob-1/reject",
      );
    });

    it("capability update for non-friend returns 404 from instance", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: false,
        status: 404,
        error: "Friend not found",
      });

      const res = await app.request(
        `/api/instances/${BOB}/friends/peer-charlie/capabilities`,
        {
          method: "PATCH",
          headers: jsonAuth,
          body: JSON.stringify({ capabilities: ["message-only"] }),
        },
      );

      expect(res.status).toBe(404);
    });

    it.todo("blocking a user prevents future friend requests (no block endpoint yet)");

    it("friend request to non-existent peer returns error from instance", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: false,
        status: 404,
        error: "Peer not found on network",
      });

      const res = await app.request(`/api/instances/${ALICE}/friends/requests`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ peerId: "peer-nonexistent" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Peer not found on network");
    });

    it("friend request with missing peerId returns 400 validation error", async () => {
      const res = await app.request(`/api/instances/${ALICE}/friends/requests`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Validation failed");
    });

    it("instance unavailable returns 503", async () => {
      mockProxyToInstance.mockResolvedValue({
        ok: false,
        status: 503,
        error: "Instance unavailable",
      });

      const res = await app.request(`/api/instances/${ALICE}/friends`, {
        headers: authHeader,
      });

      expect(res.status).toBe(503);
    });
  });
});
