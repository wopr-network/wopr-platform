import type Docker from "dockerode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DockerManager } from "./docker.js";

// ---------------------------------------------------------------------------
// Mock Docker client factory
// ---------------------------------------------------------------------------

function createMockDocker() {
  const mockContainer = {
    id: "abc123",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn(),
    logs: vi.fn(),
    export: vi.fn(),
    restart: vi.fn().mockResolvedValue(undefined),
  };

  const docker = {
    listContainers: vi.fn().mockResolvedValue([]),
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    pull: vi.fn().mockResolvedValue("stream"),
    importImage: vi.fn().mockResolvedValue("stream"),
    getEvents: vi.fn().mockResolvedValue("stream"),
    modem: {
      followProgress: vi.fn((_stream: unknown, cb: (err: Error | null) => void) => {
        cb(null);
      }),
    },
  } as unknown as Docker;

  return { docker, mockContainer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DockerManager", () => {
  let docker: Docker;
  let mockContainer: ReturnType<typeof createMockDocker>["mockContainer"];
  let manager: DockerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMockDocker();
    docker = mocks.docker;
    mockContainer = mocks.mockContainer;
    manager = new DockerManager(docker);
  });

  describe("listTenantContainers", () => {
    it("returns only containers whose names start with tenant_ prefix", async () => {
      (docker.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Names: ["/tenant_abc-bot1"], Id: "c1", State: "running" },
        { Names: ["/other-container"], Id: "c2", State: "running" },
        { Names: ["/tenant_xyz-bot2"], Id: "c3", State: "exited" },
      ]);

      const result = await manager.listTenantContainers();

      expect(result).toHaveLength(2);
      expect(result[0].Names).toEqual(["/tenant_abc-bot1"]);
      expect(result[1].Names).toEqual(["/tenant_xyz-bot2"]);
    });

    it("calls docker.listContainers with all: true", async () => {
      await manager.listTenantContainers();

      expect(docker.listContainers).toHaveBeenCalledWith({ all: true });
    });

    it("returns empty array when no tenant containers exist", async () => {
      (docker.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { Names: ["/redis"], Id: "c1", State: "running" },
      ]);

      const result = await manager.listTenantContainers();
      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // startBot
  // ---------------------------------------------------------------------------

  describe("startBot", () => {
    it("pulls image, creates container, and starts it", async () => {
      const id = await manager.startBot({
        name: "my-bot",
        image: "wopr/bot:latest",
        env: { TOKEN: "secret", MODE: "prod" },
      });

      expect(docker.pull).toHaveBeenCalledWith("wopr/bot:latest");
      expect(docker.createContainer).toHaveBeenCalledWith({
        Image: "wopr/bot:latest",
        name: "tenant_my-bot",
        Env: expect.arrayContaining(["TOKEN=secret", "MODE=prod"]),
        HostConfig: {
          RestartPolicy: { Name: "unless-stopped" },
        },
      });
      expect(mockContainer.start).toHaveBeenCalled();
      expect(id).toBe("abc123");
    });

    it("prepends tenant_ prefix only when not already present", async () => {
      await manager.startBot({ name: "tenant_already", image: "img:1" });

      expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ name: "tenant_already" }));
    });

    it("uses custom restart policy when provided", async () => {
      await manager.startBot({ name: "bot", image: "img:1", restart: "always" });

      expect(docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: { RestartPolicy: { Name: "always" } },
        }),
      );
    });

    it("passes empty Env array when no env provided", async () => {
      await manager.startBot({ name: "bot", image: "img:1" });

      expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ Env: [] }));
    });

    it("rejects when image pull fails", async () => {
      (docker.modem as unknown as { followProgress: ReturnType<typeof vi.fn> }).followProgress.mockImplementation(
        (_stream: unknown, cb: (err: Error | null) => void) => {
          cb(new Error("pull failed: unauthorized"));
        },
      );

      await expect(manager.startBot({ name: "bot", image: "bad:img" })).rejects.toThrow("pull failed: unauthorized");
    });
  });

  // ---------------------------------------------------------------------------
  // stopBot
  // ---------------------------------------------------------------------------

  describe("stopBot", () => {
    it("calls stop on the named container", async () => {
      await manager.stopBot("tenant_my-bot");

      expect(docker.getContainer).toHaveBeenCalledWith("tenant_my-bot");
      expect(mockContainer.stop).toHaveBeenCalled();
    });

    it("propagates error when container.stop rejects", async () => {
      mockContainer.stop.mockRejectedValue(new Error("No such container"));

      await expect(manager.stopBot("nonexistent")).rejects.toThrow("No such container");
    });
  });

  // ---------------------------------------------------------------------------
  // removeBot
  // ---------------------------------------------------------------------------

  describe("removeBot", () => {
    it("stops then removes the container", async () => {
      await manager.removeBot("tenant_bot");

      expect(docker.getContainer).toHaveBeenCalledWith("tenant_bot");
      expect(mockContainer.stop).toHaveBeenCalled();
      expect(mockContainer.remove).toHaveBeenCalled();
    });

    it("tolerates already-stopped container", async () => {
      mockContainer.stop.mockRejectedValue(new Error("container already stopped"));

      await expect(manager.removeBot("tenant_bot")).resolves.toBeUndefined();
      expect(mockContainer.remove).toHaveBeenCalled();
    });

    it("throws non-stopped errors from stop", async () => {
      mockContainer.stop.mockRejectedValue(new Error("permission denied"));

      await expect(manager.removeBot("tenant_bot")).rejects.toThrow("permission denied");
    });
  });

  // ---------------------------------------------------------------------------
  // restartBot
  // ---------------------------------------------------------------------------

  describe("restartBot", () => {
    it("calls restart on the named container", async () => {
      await manager.restartBot("tenant_bot");

      expect(docker.getContainer).toHaveBeenCalledWith("tenant_bot");
      expect(mockContainer.restart).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getLogs
  // ---------------------------------------------------------------------------

  describe("getLogs", () => {
    it("fetches logs with default tail of 100", async () => {
      const buf = Buffer.from("line1\nline2\n");
      mockContainer.logs.mockResolvedValue(buf);

      const logs = await manager.getLogs("tenant_bot");

      expect(mockContainer.logs).toHaveBeenCalledWith({
        stdout: true,
        stderr: true,
        tail: 100,
        timestamps: true,
      });
      expect(logs).toBe("line1\nline2\n");
    });

    it("respects custom tail parameter", async () => {
      mockContainer.logs.mockResolvedValue(Buffer.from(""));

      await manager.getLogs("tenant_bot", 50);

      expect(mockContainer.logs).toHaveBeenCalledWith(expect.objectContaining({ tail: 50 }));
    });
  });
});
