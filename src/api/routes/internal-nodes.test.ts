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
    vi.mocked(nodeRepo.getBySecret).mockReturnValue(null);

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

  it("returns 401 for expired/invalid registration token", async () => {
    delete process.env.NODE_SECRET;
    const tokenStore = getRegistrationTokenStore();
    vi.mocked(tokenStore.consume).mockReturnValue(null);

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
});
