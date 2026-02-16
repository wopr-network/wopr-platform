import type Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileRepository } from "../domain/repositories/profile-repository.js";
import type { FleetManager } from "./fleet-manager.js";
import type { ImagePoller } from "./image-poller.js";
import type { BotProfile } from "./types.js";
import { ContainerUpdater } from "./updater.js";

// --- Mock helpers ---

function makeProfile(overrides: Partial<BotProfile> = {}): BotProfile {
  return {
    id: "bot-1",
    tenantId: "user-123",
    name: "test-bot",
    description: "A test bot",
    image: "ghcr.io/wopr-network/wopr:stable",
    env: {},
    restartPolicy: "unless-stopped",
    releaseChannel: "stable",
    updatePolicy: "manual",
    ...overrides,
  };
}

function mockStore(profiles: BotProfile[] = []): ProfileRepository {
  const map = new Map(profiles.map((p) => [p.id, p]));
  return {
    save: vi.fn().mockImplementation(async (p: BotProfile) => {
      map.set(p.id, p);
    }),
    get: vi.fn().mockImplementation(async (id: string) => map.get(id) ?? null),
    list: vi.fn().mockImplementation(async () => [...map.values()]),
    delete: vi.fn().mockImplementation(async (id: string) => map.delete(id)),
  } as unknown as ProfileRepository;
}

function mockContainer(overrides: Record<string, unknown> = {}) {
  return {
    id: "container-123",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({
      Id: "container-123",
      Image: "sha256:abc123",
      Created: "2026-01-01T00:00:00Z",
      State: {
        Status: "running",
        Running: true,
        StartedAt: "2026-01-01T00:00:00Z",
        Health: { Status: "healthy" },
      },
    }),
    ...overrides,
  };
}

function mockDocker(container: ReturnType<typeof mockContainer> | null = null) {
  return {
    pull: vi.fn().mockResolvedValue("stream"),
    createContainer: vi.fn().mockResolvedValue(container ?? mockContainer()),
    listContainers: vi.fn().mockResolvedValue(container ? [{ Id: "container-123" }] : []),
    getContainer: vi.fn().mockReturnValue(container),
    getImage: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ RepoDigests: ["ghcr.io/wopr-network/wopr@sha256:abc123"] }),
    }),
    modem: {
      followProgress: vi.fn((_stream: unknown, cb: (err: Error | null) => void) => cb(null)),
    },
  };
}

function mockFleet() {
  return {
    update: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
  } as unknown as FleetManager;
}

function mockPoller() {
  return {} as unknown as ImagePoller;
}

describe("ContainerUpdater", () => {
  let docker: ReturnType<typeof mockDocker>;
  let store: ProfileRepository;
  let container: ReturnType<typeof mockContainer>;
  let fleet: ReturnType<typeof mockFleet>;
  let updater: ContainerUpdater;

  beforeEach(() => {
    vi.useFakeTimers();
    container = mockContainer();
    docker = mockDocker(container);
    store = mockStore([makeProfile()]);
    fleet = mockFleet();
    updater = new ContainerUpdater(docker as unknown as Docker, store, fleet as FleetManager, mockPoller());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --- Bot not found ---

  describe("bot not found", () => {
    it("returns error when bot profile does not exist", async () => {
      const result = await updater.updateBot("nonexistent");
      expect(result).toEqual({
        botId: "nonexistent",
        success: false,
        previousImage: "",
        newImage: "",
        previousDigest: null,
        newDigest: null,
        rolledBack: false,
        error: "Bot not found",
      });
    });
  });

  // --- Successful update flow ---

  describe("successful update", () => {
    it("pulls image, delegates to fleet.update, starts, and verifies health", async () => {
      // getContainerDigest: listContainers + getContainer + getImage
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      // wasRunning check: listContainers + getContainer.inspect
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      // waitForHealthy: listContainers + getContainer.inspect
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      // getContainerDigest after update
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);

      docker.getContainer.mockReturnValue(container);

      const promise = updater.updateBot("bot-1");
      // Advance past health check poll
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.rolledBack).toBe(false);
      expect(result.previousImage).toBe("ghcr.io/wopr-network/wopr:stable");
      expect(result.newImage).toBe("ghcr.io/wopr-network/wopr:stable");
      expect(result.previousDigest).toBe("sha256:abc123");
      expect(result.newDigest).toBe("sha256:abc123");

      // Verify the update pipeline was called
      expect(docker.pull).toHaveBeenCalledWith("ghcr.io/wopr-network/wopr:stable");
      expect(fleet.update).toHaveBeenCalledWith("bot-1", { image: "ghcr.io/wopr-network/wopr:stable" });
      expect(fleet.start).toHaveBeenCalledWith("bot-1");
    });

    it("skips start and health check when container was not running", async () => {
      const stoppedContainer = mockContainer({
        inspect: vi.fn().mockResolvedValue({
          Id: "container-123",
          Image: "sha256:abc123",
          State: { Status: "exited", Running: false },
        }),
      });

      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      // getContainerDigest after update
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);

      docker.getContainer.mockReturnValue(stoppedContainer);
      docker.getImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ RepoDigests: ["ghcr.io/wopr-network/wopr@sha256:abc123"] }),
      });

      const result = await updater.updateBot("bot-1");

      expect(result.success).toBe(true);
      expect(fleet.update).toHaveBeenCalled();
      expect(fleet.start).not.toHaveBeenCalled();
    });

    it("considers container healthy when no HEALTHCHECK is configured", async () => {
      const noHealthContainer = mockContainer({
        inspect: vi.fn().mockResolvedValue({
          Id: "container-123",
          Image: "sha256:abc123",
          State: {
            Status: "running",
            Running: true,
            Health: undefined,
          },
        }),
      });

      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      // waitForHealthy
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      // getContainerDigest after update
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);

      docker.getContainer.mockReturnValue(noHealthContainer);
      docker.getImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ RepoDigests: ["ghcr.io/wopr-network/wopr@sha256:abc123"] }),
      });

      const promise = updater.updateBot("bot-1");
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.rolledBack).toBe(false);
    });
  });

  // --- Rollback on health check failure ---

  describe("rollback on health check failure", () => {
    it("rolls back when container becomes unhealthy", async () => {
      const unhealthyContainer = mockContainer({
        inspect: vi.fn().mockResolvedValue({
          Id: "container-123",
          Image: "sha256:new999",
          State: {
            Status: "running",
            Running: true,
            Health: { Status: "unhealthy" },
          },
        }),
      });

      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // waitForHealthy — returns unhealthy container
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(unhealthyContainer);

      const promise = updater.updateBot("bot-1");
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(result.error).toContain("Health check failed");
      // Rollback calls fleet.update with the previous image
      expect(fleet.update).toHaveBeenCalledTimes(2);
      expect(fleet.update).toHaveBeenLastCalledWith("bot-1", { image: "ghcr.io/wopr-network/wopr:stable" });
      // Rollback starts the container since it was running
      expect(fleet.start).toHaveBeenCalledTimes(2);
    });

    it("rolls back when health check times out (stays in starting)", async () => {
      const startingContainer = mockContainer({
        inspect: vi.fn().mockResolvedValue({
          Id: "container-123",
          Image: "sha256:new999",
          State: {
            Status: "running",
            Running: true,
            Health: { Status: "starting" },
          },
        }),
      });

      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // waitForHealthy polls — always returns "starting"
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValue(startingContainer);

      const promise = updater.updateBot("bot-1");
      // Advance past the 60s timeout (60_000ms) in increments of poll interval (5_000ms)
      for (let i = 0; i < 13; i++) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(result.error).toContain("Health check failed");
    });
  });

  // --- Rollback on startup failure ---

  describe("rollback on startup failure", () => {
    it("rolls back when fleet.start throws", async () => {
      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);

      // fleet.start fails after fleet.update succeeds
      (fleet.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Container start failed"));

      const result = await updater.updateBot("bot-1");

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      // Rollback was attempted via fleet.update with previous image
      expect(fleet.update).toHaveBeenLastCalledWith("bot-1", { image: "ghcr.io/wopr-network/wopr:stable" });
    });

    it("reports double failure when rollback also fails", async () => {
      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);

      // fleet.start fails
      (fleet.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Container start failed"));
      // fleet.update (rollback) also fails
      (fleet.update as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined) // initial update succeeds
        .mockRejectedValueOnce(new Error("Rollback recreate failed")); // rollback fails

      const result = await updater.updateBot("bot-1");

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(false);
      expect(result.error).toContain("Update failed");
      expect(result.error).toContain("Rollback also failed");
    });
  });

  // --- Image pull failure ---

  describe("image pull failure", () => {
    it("rolls back when image pull fails", async () => {
      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);

      // Pull fails
      docker.modem.followProgress.mockImplementationOnce((_stream: unknown, cb: (err: Error | null) => void) =>
        cb(new Error("Image not found: 404")),
      );

      const result = await updater.updateBot("bot-1");

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      // fleet.update should NOT have been called for the initial update (pull failed before it)
      // but SHOULD be called for rollback
      expect(fleet.update).toHaveBeenCalledTimes(1);
      expect(fleet.update).toHaveBeenCalledWith("bot-1", { image: "ghcr.io/wopr-network/wopr:stable" });
    });

    it("returns error when pull fails and rollback also fails", async () => {
      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);

      // Pull fails
      docker.modem.followProgress.mockImplementationOnce((_stream: unknown, cb: (err: Error | null) => void) =>
        cb(new Error("Network timeout")),
      );
      // Rollback also fails
      (fleet.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Docker daemon unreachable"));

      const result = await updater.updateBot("bot-1");

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(false);
      expect(result.error).toContain("Network timeout");
      expect(result.error).toContain("Rollback also failed");
    });
  });

  // --- Concurrent update prevention ---

  describe("concurrent update prevention", () => {
    it("rejects concurrent updates to the same bot", async () => {
      // Make the first update hang on pull
      let resolvePull: ((err: Error | null) => void) | null = null;
      docker.modem.followProgress.mockImplementationOnce((_stream: unknown, cb: (err: Error | null) => void) => {
        resolvePull = cb;
      });

      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);

      // Start first update (hangs on pull)
      const first = updater.updateBot("bot-1");

      // Wait for pull to start
      await vi.waitFor(() => {
        expect(resolvePull).not.toBeNull();
      });

      // Second attempt should be rejected immediately
      const second = await updater.updateBot("bot-1");
      expect(second.success).toBe(false);
      expect(second.error).toBe("Update already in progress");
      expect(second.rolledBack).toBe(false);

      // Let first complete
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by waitFor
      resolvePull!(null);

      // Provide remaining mocks for first update to complete
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]); // waitForHealthy
      docker.getContainer.mockReturnValueOnce(container);
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]); // final digest
      docker.getContainer.mockReturnValueOnce(container);

      const firstResult = await first;
      expect(firstResult.success).toBe(true);
    });

    it("allows updates to different bots concurrently", async () => {
      const profile2 = makeProfile({ id: "bot-2", name: "second-bot" });
      store = mockStore([makeProfile(), profile2]);
      updater = new ContainerUpdater(docker as unknown as Docker, store, fleet as FleetManager, mockPoller());

      // Bot-1 hangs on pull
      let resolvePull1: ((err: Error | null) => void) | null = null;
      docker.modem.followProgress.mockImplementationOnce((_stream: unknown, cb: (err: Error | null) => void) => {
        resolvePull1 = cb;
      });

      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValue(container);

      const first = updater.updateBot("bot-1");
      await vi.waitFor(() => expect(resolvePull1).not.toBeNull());

      // Bot-2 should succeed (different bot, no lock conflict)
      const promise2 = updater.updateBot("bot-2");
      await vi.advanceTimersByTimeAsync(0);
      const second = await promise2;

      expect(second.success).toBe(true);
      expect(second.botId).toBe("bot-2");

      // Cleanup: unblock first update
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by waitFor
      resolvePull1!(null);
      await first;
    });

    it("releases lock after update failure", async () => {
      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);

      // Pull fails
      docker.modem.followProgress.mockImplementationOnce((_stream: unknown, cb: (err: Error | null) => void) =>
        cb(new Error("Pull failed")),
      );

      const first = await updater.updateBot("bot-1");
      expect(first.success).toBe(false);

      // Now a second attempt should work (lock released)
      docker.modem.followProgress.mockImplementationOnce((_stream: unknown, cb: (err: Error | null) => void) =>
        cb(null),
      );
      docker.listContainers.mockResolvedValue([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValue(container);

      const promise2 = updater.updateBot("bot-1");
      await vi.advanceTimersByTimeAsync(0);
      const second = await promise2;
      expect(second.success).toBe(true);
    });
  });

  // --- Volume preservation ---

  describe("volume preservation during update", () => {
    it("delegates recreation to fleet.update which preserves volumes", async () => {
      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // waitForHealthy
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // final digest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);

      const promise = updater.updateBot("bot-1");
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;

      expect(result.success).toBe(true);
      // fleet.update is called (not fleet.remove + fleet.create), which preserves volumes
      expect(fleet.update).toHaveBeenCalledWith("bot-1", { image: "ghcr.io/wopr-network/wopr:stable" });
      // Verify that direct container.remove was NOT called (that would lose volumes)
      expect(container.remove).not.toHaveBeenCalled();
    });
  });

  // --- Digest tracking ---

  describe("digest tracking", () => {
    it("captures previous and new digests on success", async () => {
      const newContainer = mockContainer();
      const newImage = {
        inspect: vi.fn().mockResolvedValue({ RepoDigests: ["ghcr.io/wopr-network/wopr@sha256:new999"] }),
      };

      // getContainerDigest (previous)
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // waitForHealthy
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(newContainer);
      // getContainerDigest (new) — return new image with different digest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-new" }]);
      docker.getContainer.mockReturnValueOnce(
        mockContainer({
          inspect: vi.fn().mockResolvedValue({ Id: "container-new", Image: "sha256:new999", State: { Running: true } }),
        }),
      );
      docker.getImage.mockReturnValueOnce({
        inspect: vi.fn().mockResolvedValue({ RepoDigests: ["ghcr.io/wopr-network/wopr@sha256:abc123"] }),
      });
      docker.getImage.mockReturnValueOnce(newImage);

      const promise = updater.updateBot("bot-1");
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.previousDigest).toBe("sha256:abc123");
      expect(result.newDigest).toBe("sha256:new999");
    });

    it("handles missing previous digest gracefully", async () => {
      // getContainerDigest throws
      docker.listContainers.mockRejectedValueOnce(new Error("Docker unavailable"));
      // wasRunning — no containers found
      docker.listContainers.mockResolvedValueOnce([]);
      // final digest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);

      const result = await updater.updateBot("bot-1");

      expect(result.success).toBe(true);
      expect(result.previousDigest).toBeNull();
    });

    it("handles missing new digest gracefully", async () => {
      // getContainerDigest (previous)
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // waitForHealthy
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // getContainerDigest (new) — fails
      docker.listContainers.mockRejectedValueOnce(new Error("Transient Docker error"));

      const promise = updater.updateBot("bot-1");
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.newDigest).toBeNull();
    });
  });

  // --- fleet.update failure ---

  describe("fleet.update failure during update", () => {
    it("rolls back when fleet.update throws during the initial update", async () => {
      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning check
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);

      // fleet.update fails on initial call, succeeds on rollback
      (fleet.update as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("Container creation failed"))
        .mockResolvedValueOnce(undefined);

      const result = await updater.updateBot("bot-1");

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(fleet.update).toHaveBeenCalledTimes(2);
    });
  });

  // --- Rollback does not start if container was stopped ---

  describe("rollback respects wasRunning", () => {
    it("does not start container during rollback if it was not running before update", async () => {
      const stoppedContainer = mockContainer({
        inspect: vi.fn().mockResolvedValue({
          Id: "container-123",
          Image: "sha256:abc123",
          State: { Status: "exited", Running: false },
        }),
      });

      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(stoppedContainer);
      // wasRunning check — stopped
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(stoppedContainer);

      docker.getImage.mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ RepoDigests: ["ghcr.io/wopr-network/wopr@sha256:abc123"] }),
      });

      // fleet.update fails, triggering rollback
      (fleet.update as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("Failed"))
        .mockResolvedValueOnce(undefined);

      const result = await updater.updateBot("bot-1");

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      // fleet.start should NOT be called at all — container was stopped
      expect(fleet.start).not.toHaveBeenCalled();
    });
  });

  // --- Edge case: wasRunning detection failure ---

  describe("wasRunning detection failure", () => {
    it("assumes stopped when container state check fails", async () => {
      // getContainerDigest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);
      // wasRunning check — throws
      docker.listContainers.mockRejectedValueOnce(new Error("Docker socket error"));
      // final digest
      docker.listContainers.mockResolvedValueOnce([{ Id: "container-123" }]);
      docker.getContainer.mockReturnValueOnce(container);

      const result = await updater.updateBot("bot-1");

      expect(result.success).toBe(true);
      // Since wasRunning defaults to false on error, start and health check are skipped
      expect(fleet.start).not.toHaveBeenCalled();
    });
  });
});
