import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fleet services before importing routes
vi.mock("../../fleet/services.js", () => {
  const mockNodeRepo = {
    verifyNodeSecret: vi.fn(),
    getBySecret: vi.fn(),
    getById: vi.fn(),
  };
  return {
    getNodeRepo: () => mockNodeRepo,
    getConnectionRegistry: () => ({ accept: vi.fn() }),
    getHeartbeatProcessor: () => ({ process: vi.fn() }),
    getCommandBus: () => ({ handle: vi.fn() }),
    getNodeConnections: () => ({}),
  };
});

import { getNodeRepo } from "../../fleet/services.js";
import { authenticateWebSocketUpgrade } from "./ws-auth.js";

/**
 * These tests verify the WebSocket upgrade auth logic extracted into a helper.
 * The actual upgrade handler lives in src/index.ts but the auth decision
 * is testable via the exported function.
 */
describe("WebSocket nodeId binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("per-node secret (Path 2) rejects when bearer resolves to different nodeId", async () => {
    const nodeRepo = getNodeRepo() as ReturnType<typeof getNodeRepo> & {
      getBySecret: ReturnType<typeof vi.fn>;
    };
    // Bearer resolves to node-2, but URL says node-1
    nodeRepo.getBySecret.mockResolvedValue({ id: "node-2" });

    const result = await authenticateWebSocketUpgrade({
      nodeId: "node-1",
      authHeader: "Bearer wopr_node_abc",
      nodeSecretHeader: undefined,
    });

    expect(result.authenticated).toBe(false);
  });

  it("per-node secret (Path 2) accepts when bearer resolves to matching nodeId", async () => {
    const nodeRepo = getNodeRepo() as ReturnType<typeof getNodeRepo> & {
      getBySecret: ReturnType<typeof vi.fn>;
    };
    nodeRepo.getBySecret.mockResolvedValue({ id: "node-1" });

    const result = await authenticateWebSocketUpgrade({
      nodeId: "node-1",
      authHeader: "Bearer wopr_node_abc",
      nodeSecretHeader: undefined,
    });

    expect(result.authenticated).toBe(true);
    expect(result.nodeId).toBe("node-1");
  });

  it("rejects with no-auth-configured when no bearer", async () => {
    const result = await authenticateWebSocketUpgrade({
      nodeId: "node-1",
      authHeader: undefined,
      nodeSecretHeader: undefined,
    });

    expect(result.authenticated).toBe(false);
    expect(result.reason).toContain("no auth configured");
  });
});
