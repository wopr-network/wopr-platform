import { describe, expect, it, vi } from "vitest";
import type { CommandResult, NodeConnectionRegistry } from "./node-command-bus.js";
import { NodeCommandBus } from "./node-command-bus.js";

interface MockSocket {
  send: (data: string) => void;
  readyState: number;
  _spy: ReturnType<typeof vi.fn>;
}

function mockSocket(readyState = 1): MockSocket {
  const spy = vi.fn();
  return { send: spy as (data: string) => void, readyState, _spy: spy };
}

function mockRegistry(sockets: Record<string, MockSocket> = {}): NodeConnectionRegistry {
  return {
    getSocket(nodeId: string) {
      const s = sockets[nodeId];
      return s ?? null;
    },
  };
}

describe("NodeCommandBus", () => {
  it("throws when node is not connected", async () => {
    const bus = new NodeCommandBus(mockRegistry());
    await expect(bus.send("node-unknown", { type: "bot.start", payload: {} })).rejects.toThrow("not connected");
  });

  it("resolves with command result on success", async () => {
    const ws = mockSocket();
    const bus = new NodeCommandBus(mockRegistry({ "node-1": ws }));

    const promise = bus.send("node-1", { type: "bot.start", payload: { tenantId: "t1" } });

    // Extract the command ID from what was sent over the socket
    expect(ws._spy).toHaveBeenCalledOnce();
    const sent = JSON.parse(ws._spy.mock.calls[0][0] as string);
    expect(sent.id).toEqual(expect.any(String));
    expect(sent.type).toBe("bot.start");
    expect(sent.payload).toEqual({ tenantId: "t1" });

    // Simulate the node agent responding
    const result: CommandResult = {
      id: sent.id,
      type: "command_result",
      command: "bot.start",
      success: true,
      data: { containerId: "abc123" },
    };
    bus.handleResult(result);

    const resolved = await promise;
    expect(resolved).toEqual(result);
  });

  it("rejects with error when handleResult is called with success: false", async () => {
    const ws = mockSocket();
    const bus = new NodeCommandBus(mockRegistry({ "node-1": ws }));

    const promise = bus.send("node-1", { type: "bot.start", payload: { tenantId: "t1" } });

    const sent = JSON.parse(ws._spy.mock.calls[0][0] as string);
    const result: CommandResult = {
      id: sent.id,
      type: "command_result",
      command: "bot.start",
      success: false,
      error: "container failed to start",
    };
    bus.handleResult(result);

    await expect(promise).rejects.toThrow("container failed to start");
  });

  it("rejects with generic message when handleResult has success: false and no error", async () => {
    const ws = mockSocket();
    const bus = new NodeCommandBus(mockRegistry({ "node-1": ws }));

    const promise = bus.send("node-1", { type: "bot.start", payload: {} });

    const sent = JSON.parse(ws._spy.mock.calls[0][0] as string);
    const result: CommandResult = {
      id: sent.id,
      type: "command_result",
      command: "bot.start",
      success: false,
    };
    bus.handleResult(result);

    await expect(promise).rejects.toThrow("command failed");
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();
    try {
      const ws = mockSocket();
      const bus = new NodeCommandBus(mockRegistry({ "node-1": ws }), { timeoutMs: 10 });

      const promise = bus.send("node-1", { type: "bot.stop", payload: {} });

      // Advance time past the timeout
      vi.advanceTimersByTime(11);

      await expect(promise).rejects.toThrow("timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});
