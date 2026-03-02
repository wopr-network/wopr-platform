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
import { internalNodeRoutes, validateNodeAuth } from "./internal-nodes.js";

describe("validateNodeAuth", () => {
  const originalSecret = process.env.NODE_SECRET;

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.NODE_SECRET = originalSecret;
    } else {
      delete process.env.NODE_SECRET;
    }
  });

  it("returns null when NODE_SECRET is not configured", () => {
    delete process.env.NODE_SECRET;
    expect(validateNodeAuth("Bearer test")).toBeNull();
  });

  it("returns false when no auth header provided", () => {
    process.env.NODE_SECRET = "my-secret";
    expect(validateNodeAuth(undefined)).toBe(false);
  });

  it("returns true when bearer matches NODE_SECRET", () => {
    process.env.NODE_SECRET = "my-secret";
    expect(validateNodeAuth("Bearer my-secret")).toBe(true);
  });

  it("returns false when bearer does not match NODE_SECRET", () => {
    process.env.NODE_SECRET = "my-secret";
    expect(validateNodeAuth("Bearer wrong")).toBe(false);
  });
});

describe("POST /register", () => {
  const originalSecret = process.env.NODE_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.NODE_SECRET = originalSecret;
    } else {
      delete process.env.NODE_SECRET;
    }
  });

  it("returns 401 when no authorization header", async () => {
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: "n1", host: "h", capacity_mb: 100, agent_version: "1.0" }),
    });
    expect(res.status).toBe(401);
  });

  it("registers node via static NODE_SECRET", async () => {
    process.env.NODE_SECRET = "static-secret";
    const registrar = getNodeRegistrar();

    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer static-secret",
      },
      body: JSON.stringify({ node_id: "n1", host: "10.0.0.1", capacity_mb: 1024, agent_version: "2.0" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(registrar.register).toHaveBeenCalledWith({
      nodeId: "n1",
      host: "10.0.0.1",
      capacityMb: 1024,
      agentVersion: "2.0",
    });
  });

  it("re-registers node via per-node secret", async () => {
    delete process.env.NODE_SECRET;
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
    delete process.env.NODE_SECRET;
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
    delete process.env.NODE_SECRET;
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

  it("rejects static-secret auth when X-Node-Secret does not match stored hash", async () => {
    process.env.NODE_SECRET = "fleet-secret";
    const nodeRepo = getNodeRepo() as ReturnType<typeof getNodeRepo> & { verifyNodeSecret: ReturnType<typeof vi.fn> };
    nodeRepo.verifyNodeSecret.mockResolvedValue(false);

    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        Authorization: "Bearer fleet-secret",
        "Content-Type": "application/json",
        "X-Node-Secret": "wrong_node_secret",
      },
      body: JSON.stringify({ node_id: "node-1", host: "10.0.0.1", capacity_mb: 4096, agent_version: "1.0.0" }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("node secret");
  });

  it("allows static-secret auth when node has no stored secret (legacy)", async () => {
    process.env.NODE_SECRET = "fleet-secret";
    const nodeRepo = getNodeRepo() as ReturnType<typeof getNodeRepo> & { verifyNodeSecret: ReturnType<typeof vi.fn> };
    nodeRepo.verifyNodeSecret.mockResolvedValue(null);
    const registrar = getNodeRegistrar();

    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        Authorization: "Bearer fleet-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ node_id: "legacy-node", host: "10.0.0.1", capacity_mb: 4096, agent_version: "1.0.0" }),
    });

    expect(res.status).toBe(200);
    expect(registrar.register).toHaveBeenCalled();
  });

  it("allows static-secret auth when X-Node-Secret matches stored hash", async () => {
    process.env.NODE_SECRET = "fleet-secret";
    const nodeRepo = getNodeRepo() as ReturnType<typeof getNodeRepo> & { verifyNodeSecret: ReturnType<typeof vi.fn> };
    nodeRepo.verifyNodeSecret.mockResolvedValue(true);
    const registrar = getNodeRegistrar();

    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        Authorization: "Bearer fleet-secret",
        "Content-Type": "application/json",
        "X-Node-Secret": "wopr_node_correct",
      },
      body: JSON.stringify({ node_id: "node-1", host: "10.0.0.1", capacity_mb: 4096, agent_version: "1.0.0" }),
    });

    expect(res.status).toBe(200);
    expect(registrar.register).toHaveBeenCalled();
  });

  it("returns 401 for expired/invalid registration token", async () => {
    delete process.env.NODE_SECRET;
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
    process.env.NODE_SECRET = "static-secret";

    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer static-secret",
      },
      body: "not-json",
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when node_id contains invalid characters", async () => {
    process.env.NODE_SECRET = "static-secret";
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer static-secret",
      },
      body: JSON.stringify({ node_id: "../etc/passwd", host: "10.0.0.1", capacity_mb: 1024, agent_version: "2.0" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it("returns 400 when host contains invalid characters", async () => {
    process.env.NODE_SECRET = "static-secret";
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer static-secret",
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
    process.env.NODE_SECRET = "static-secret";
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer static-secret",
      },
      body: JSON.stringify({ node_id: "n1", host: "10.0.0.1", capacity_mb: -1, agent_version: "2.0" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when capacity_mb is Infinity", async () => {
    process.env.NODE_SECRET = "static-secret";
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer static-secret",
      },
      body: JSON.stringify({ node_id: "n1", host: "10.0.0.1", capacity_mb: Infinity, agent_version: "2.0" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    process.env.NODE_SECRET = "static-secret";
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer static-secret",
      },
      body: JSON.stringify({ node_id: "n1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when node_id exceeds max length", async () => {
    process.env.NODE_SECRET = "static-secret";
    const res = await internalNodeRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer static-secret",
      },
      body: JSON.stringify({ node_id: "a".repeat(129), host: "10.0.0.1", capacity_mb: 1024, agent_version: "2.0" }),
    });
    expect(res.status).toBe(400);
  });
});
