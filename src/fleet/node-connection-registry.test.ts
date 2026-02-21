import { describe, expect, it, vi } from "vitest";
import { NodeConnectionRegistry } from "./node-connection-registry.js";

function mockWs(readyState = 1) {
  return { readyState, close: vi.fn() } as unknown as import("ws").WebSocket;
}

describe("NodeConnectionRegistry", () => {
  it("isConnected returns false for unknown node", () => {
    const reg = new NodeConnectionRegistry();
    expect(reg.isConnected("node-unknown")).toBe(false);
  });

  it("isConnected returns true after accept", () => {
    const reg = new NodeConnectionRegistry();
    reg.accept("node-1", mockWs());
    expect(reg.isConnected("node-1")).toBe(true);
  });

  it("close removes the connection and calls ws.close()", () => {
    const reg = new NodeConnectionRegistry();
    const ws = mockWs();
    reg.accept("node-1", ws);

    reg.close("node-1");

    expect(ws.close).toHaveBeenCalled();
    expect(reg.isConnected("node-1")).toBe(false);
    expect(reg.getSocket("node-1")).toBeNull();
  });

  it("getSocket returns null for unknown node", () => {
    const reg = new NodeConnectionRegistry();
    expect(reg.getSocket("node-unknown")).toBeNull();
  });

  it("listConnected returns only OPEN (readyState === 1) connections", () => {
    const reg = new NodeConnectionRegistry();
    reg.accept("node-open", mockWs(1));
    reg.accept("node-closing", mockWs(2));
    reg.accept("node-closed", mockWs(3));

    const connected = reg.listConnected();
    expect(connected).toEqual(["node-open"]);
  });
});
