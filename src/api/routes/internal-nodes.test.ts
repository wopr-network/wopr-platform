import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fleet services before importing routes
vi.mock("../../fleet/services.js", () => {
  const mockRegistrar = {
    register: vi.fn(),
    registerSelfHosted: vi.fn(),
  };
  const mockNodeRepo = {
    getBySecret: vi.fn(),
    verifyNodeSecret: vi.fn().mockResolvedValue(null), // default: legacy node (no stored secret)
  };
  const mockTokenStore = {
    consume: vi.fn(),
  };
  return {
    getNodeRegistrar: () => mockRegistrar,
    getNodeRepo: () => mockNodeRepo,
    getRegistrationTokenStore: () => mockTokenStore,
    // Keep getNodeConnections stub for any transitive imports
    getNodeConnections: () => ({}),
  };
});

import { getNodeRegistrar, getNodeRepo, getRegistrationTokenStore } from "../../fleet/services.js";
import { internalNodeRoutes } from "./internal-nodes.js";

describe("POST /register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ALLOW_PRIVATE_NODE_HOSTS = "true";
  });

  afterEach(() => {
    delete process.env.ALLOW_PRIVATE_NODE_HOSTS;
  });

  it("returns 401 when no authorization header", async () => {
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: "n1", host: "h", capacity_mb: 100, agent_version: "1.0" }),
    });
    expect(res.status).toBe(401);
  });

  it("re-registers node via per-node secret", async () => {
    const nodeRepo = getNodeRepo();
    const registrar = getNodeRegistrar();

    vi.mocked(nodeRepo.getBySecret).mockReturnValue({ id: "existing-node", host: "10.0.0.1" } as never);

    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wopr_node_abc123",
      },
      body: JSON.stringify({ node_id: "ignored", host: "10.0.0.2", capacity_mb: 512, agent_version: "2.0" }),
    });

    expect(res.status).toBe(200);
    expect(registrar.register).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "existing-node" }));
  });

  it("returns 401 for invalid per-node secret", async () => {
    const nodeRepo = getNodeRepo();
    vi.mocked(nodeRepo.getBySecret).mockResolvedValue(null);

    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wopr_node_invalid",
      },
      body: JSON.stringify({ node_id: "n1", host: "h", capacity_mb: 100, agent_version: "1.0" }),
    });

    expect(res.status).toBe(401);
  });

  it("registers self-hosted node via registration token", async () => {
    const tokenStore = getRegistrationTokenStore();
    const registrar = getNodeRegistrar();

    const token = randomUUID();
    vi.mocked(tokenStore.consume).mockReturnValue({ userId: "user-1", label: "my-node" } as never);

    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ node_id: "n1", host: "10.0.0.3", capacity_mb: 2048, agent_version: "2.0" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.node_id).toMatch(/^self-/);
    expect(json.node_secret).toMatch(/^wopr_node_/);
    expect(registrar.registerSelfHosted).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: "user-1",
        label: "my-node",
      }),
    );
  });

  it("returns 401 for expired/invalid registration token", async () => {
    const tokenStore = getRegistrationTokenStore();
    vi.mocked(tokenStore.consume).mockResolvedValue(null);

    const token = randomUUID();
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ node_id: "n1", host: "h", capacity_mb: 100, agent_version: "1.0" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON body", async () => {
    const tokenStore = getRegistrationTokenStore();
    vi.mocked(tokenStore.consume).mockResolvedValue(null);
    const token = randomUUID();
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "not-json",
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when node_id contains invalid characters", async () => {
    const tokenStore = getRegistrationTokenStore();
    vi.mocked(tokenStore.consume).mockResolvedValue(null);
    const token = randomUUID();
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ node_id: "../etc/passwd", host: "10.0.0.1", capacity_mb: 1024, agent_version: "2.0" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it("returns 400 when host contains invalid characters", async () => {
    const tokenStore = getRegistrationTokenStore();
    vi.mocked(tokenStore.consume).mockResolvedValue(null);
    const token = randomUUID();
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        node_id: "n1",
        host: "http://evil.com:8080/rce",
        capacity_mb: 1024,
        agent_version: "2.0",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when capacity_mb is negative", async () => {
    const tokenStore = getRegistrationTokenStore();
    vi.mocked(tokenStore.consume).mockResolvedValue(null);
    const token = randomUUID();
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ node_id: "n1", host: "10.0.0.1", capacity_mb: -1, agent_version: "2.0" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when capacity_mb is Infinity", async () => {
    const tokenStore = getRegistrationTokenStore();
    vi.mocked(tokenStore.consume).mockResolvedValue(null);
    const token = randomUUID();
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ node_id: "n1", host: "10.0.0.1", capacity_mb: Infinity, agent_version: "2.0" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    const tokenStore = getRegistrationTokenStore();
    vi.mocked(tokenStore.consume).mockResolvedValue(null);
    const token = randomUUID();
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ node_id: "n1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when node_id exceeds max length", async () => {
    const tokenStore = getRegistrationTokenStore();
    vi.mocked(tokenStore.consume).mockResolvedValue(null);
    const token = randomUUID();
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ node_id: "a".repeat(129), host: "10.0.0.1", capacity_mb: 1024, agent_version: "2.0" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 500 when registrar.registerSelfHosted rejects (token path)", async () => {
    const tokenStore = getRegistrationTokenStore();
    const registrar = getNodeRegistrar();

    const token = randomUUID();
    vi.mocked(tokenStore.consume).mockResolvedValue({ userId: "user-1", label: "my-node" } as never);
    vi.mocked(registrar.registerSelfHosted).mockRejectedValue(new Error("DB write failed"));

    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ node_id: "n1", host: "10.0.0.3", capacity_mb: 2048, agent_version: "2.0" }),
    });

    expect(res.status).toBe(500);
  });
});
