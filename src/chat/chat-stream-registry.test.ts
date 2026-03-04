import { describe, expect, it } from "vitest";
import { ChatStreamRegistry } from "./chat-stream-registry.js";

describe("ChatStreamRegistry", () => {
  it("registers and retrieves a writer by streamId", () => {
    const registry = new ChatStreamRegistry();
    const writer = { write: () => {}, close: () => {} } as unknown as WritableStreamDefaultWriter<string>;
    const streamId = registry.register("session-1", writer);

    expect(typeof streamId).toBe("string");
    expect(registry.get(streamId)).toBe(writer);
  });

  it("returns undefined for unknown streamId", () => {
    const registry = new ChatStreamRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("removes a writer", () => {
    const registry = new ChatStreamRegistry();
    const writer = { write: () => {}, close: () => {} } as unknown as WritableStreamDefaultWriter<string>;
    const streamId = registry.register("session-1", writer);

    registry.remove(streamId);
    expect(registry.get(streamId)).toBeUndefined();
  });

  it("lists all streamIds for a sessionId (non-ownership)", () => {
    const registry = new ChatStreamRegistry();
    const writer1 = { write: () => {}, close: () => {} } as unknown as WritableStreamDefaultWriter<string>;
    const writer2 = { write: () => {}, close: () => {} } as unknown as WritableStreamDefaultWriter<string>;

    const id1 = registry.register("session-1", writer1);
    const id2 = registry.register("session-1", writer2);
    registry.register("session-2", writer2);

    const ids = registry.listBySession("session-1");
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).toHaveLength(2);
  });
});

describe("session ownership", () => {
  it("claimOrVerifyOwner claims an unclaimed session and returns true", () => {
    const registry = new ChatStreamRegistry();
    expect(registry.claimOrVerifyOwner("session-1", "user-a")).toBe(true);
    expect(registry.getOwner("session-1")).toBe("user-a");
  });

  it("getOwner returns undefined for unknown sessions", () => {
    const registry = new ChatStreamRegistry();
    expect(registry.getOwner("unknown")).toBeUndefined();
  });

  it("claimOrVerifyOwner does not overwrite an existing owner", () => {
    const registry = new ChatStreamRegistry();
    registry.claimOrVerifyOwner("session-1", "user-a");
    registry.claimOrVerifyOwner("session-1", "user-b");
    expect(registry.getOwner("session-1")).toBe("user-a");
  });

  it("claimOrVerifyOwner returns true for the owner and false for others", () => {
    const registry = new ChatStreamRegistry();
    registry.claimOrVerifyOwner("session-1", "user-a");
    expect(registry.claimOrVerifyOwner("session-1", "user-a")).toBe(true);
    expect(registry.claimOrVerifyOwner("session-1", "user-b")).toBe(false);
  });

  it("claimOrVerifyOwner is atomic — concurrent second caller cannot claim", () => {
    const registry = new ChatStreamRegistry();
    // Simulate two concurrent callers: both call before either checks return value
    const r1 = registry.claimOrVerifyOwner("session-1", "user-a");
    const r2 = registry.claimOrVerifyOwner("session-1", "user-b");
    // Only the first caller gets true; second gets false
    expect(r1).toBe(true);
    expect(r2).toBe(false);
  });

  it("clearOwner removes the ownership record", () => {
    const registry = new ChatStreamRegistry();
    registry.claimOrVerifyOwner("session-1", "user-a");
    registry.clearOwner("session-1");
    expect(registry.getOwner("session-1")).toBeUndefined();
  });
});
