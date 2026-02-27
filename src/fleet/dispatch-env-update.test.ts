import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IBotInstanceRepository } from "./bot-instance-repository.js";
import { dispatchEnvUpdate } from "./dispatch-env-update.js";

const mockSend = vi.fn();

vi.mock("./services.js", () => ({
  getCommandBus: () => ({ send: mockSend }),
}));

function makeRepo(instance: { nodeId?: string | null } | null): IBotInstanceRepository {
  return {
    getById: vi.fn().mockResolvedValue(instance),
  } as unknown as IBotInstanceRepository;
}

describe("dispatchEnvUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches bot.update when instance has a nodeId", async () => {
    mockSend.mockResolvedValue(undefined);
    const repo = makeRepo({ nodeId: "node-1" });

    const result = await dispatchEnvUpdate("bot-1", "tenant-1", { FOO: "bar" }, repo);

    expect(result).toEqual({ dispatched: true });
    expect(mockSend).toHaveBeenCalledWith("node-1", {
      type: "bot.update",
      payload: { name: "tenant_tenant-1", env: { FOO: "bar" } },
    });
  });

  it("returns dispatched:false when instance has no nodeId", async () => {
    const repo = makeRepo({ nodeId: null });

    const result = await dispatchEnvUpdate("bot-1", "tenant-1", {}, repo);

    expect(result).toEqual({ dispatched: false, dispatchError: "bot_not_deployed" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns dispatched:false when bot instance is not found", async () => {
    const repo = makeRepo(null);

    const result = await dispatchEnvUpdate("missing-bot", "tenant-1", {}, repo);

    expect(result).toEqual({ dispatched: false, dispatchError: "bot_not_deployed" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns dispatched:false and captures error message when send throws", async () => {
    mockSend.mockRejectedValue(new Error("connection refused"));
    const repo = makeRepo({ nodeId: "node-1" });

    const result = await dispatchEnvUpdate("bot-1", "tenant-1", {}, repo);

    expect(result).toEqual({ dispatched: false, dispatchError: "connection refused" });
  });

  it("handles non-Error thrown values", async () => {
    mockSend.mockRejectedValue("string error");
    const repo = makeRepo({ nodeId: "node-1" });

    const result = await dispatchEnvUpdate("bot-1", "tenant-1", {}, repo);

    expect(result).toEqual({ dispatched: false, dispatchError: "string error" });
  });
});
