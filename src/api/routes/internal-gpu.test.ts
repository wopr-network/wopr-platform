import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../fleet/services.js", () => {
  const mockGpuNodeRepo = {
    getById: vi.fn(),
    updateStage: vi.fn(),
    updateStatus: vi.fn(),
  };
  return {
    getGpuNodeRepo: () => mockGpuNodeRepo,
  };
});

import { getGpuNodeRepo } from "../../fleet/services.js";
import { internalGpuRoutes } from "./internal-gpu.js";

const gpuRepo = getGpuNodeRepo() as ReturnType<typeof getGpuNodeRepo> & {
  getById: ReturnType<typeof vi.fn>;
  updateStage: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
};

describe("POST /register", () => {
  const originalSecret = process.env.GPU_NODE_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GPU_NODE_SECRET = "test-gpu-secret";
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.GPU_NODE_SECRET = originalSecret;
    } else {
      delete process.env.GPU_NODE_SECRET;
    }
  });

  it("returns 401 when no authorization header", async () => {
    const res = await internalGpuRoutes.request("/register?stage=done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "gpu-abc123" }),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it("returns 401 when token is wrong", async () => {
    const res = await internalGpuRoutes.request("/register?stage=done", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ nodeId: "gpu-abc123" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when nodeId is missing from body", async () => {
    const res = await internalGpuRoutes.request("/register?stage=done", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-gpu-secret",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/nodeId/i);
  });

  it("returns 400 when stage query param is missing", async () => {
    const res = await internalGpuRoutes.request("/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-gpu-secret",
      },
      body: JSON.stringify({ nodeId: "gpu-abc123" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/stage/i);
  });

  it("returns 400 when stage is invalid", async () => {
    const res = await internalGpuRoutes.request("/register?stage=bogus", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-gpu-secret",
      },
      body: JSON.stringify({ nodeId: "gpu-abc123" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/stage/i);
  });

  it("returns 404 when nodeId is not found", async () => {
    gpuRepo.updateStage.mockImplementation(() => {
      throw new Error("GPU node not found: gpu-unknown");
    });
    const res = await internalGpuRoutes.request("/register?stage=registering", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-gpu-secret",
      },
      body: JSON.stringify({ nodeId: "gpu-unknown" }),
    });
    expect(res.status).toBe(404);
  });

  it("updates stage for a valid request", async () => {
    gpuRepo.updateStage.mockImplementation(() => {});
    const res = await internalGpuRoutes.request("/register?stage=installing_docker", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-gpu-secret",
      },
      body: JSON.stringify({ nodeId: "gpu-abc123" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(gpuRepo.updateStage).toHaveBeenCalledWith("gpu-abc123", "installing_docker");
    expect(gpuRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("sets status to active when stage is done", async () => {
    gpuRepo.updateStage.mockImplementation(() => {});
    gpuRepo.updateStatus.mockImplementation(() => {});
    const res = await internalGpuRoutes.request("/register?stage=done", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-gpu-secret",
      },
      body: JSON.stringify({ nodeId: "gpu-abc123" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(gpuRepo.updateStage).toHaveBeenCalledWith("gpu-abc123", "done");
    expect(gpuRepo.updateStatus).toHaveBeenCalledWith("gpu-abc123", "active");
  });
});
