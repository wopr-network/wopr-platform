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
  it("setOwner records the owner of a session", () => {
    const registry = new ChatStreamRegistry();
    registry.setOwner("session-1", "user-a");
    expect(registry.getOwner("session-1")).toBe("user-a");
  });

  it("getOwner returns undefined for unknown sessions", () => {
    const registry = new ChatStreamRegistry();
    expect(registry.getOwner("unknown")).toBeUndefined();
  });

  it("setOwner does not overwrite an existing owner", () => {
    const registry = new ChatStreamRegistry();
    registry.setOwner("session-1", "user-a");
    registry.setOwner("session-1", "user-b");
    expect(registry.getOwner("session-1")).toBe("user-a");
  });

  it("isOwner returns true for the session owner", () => {
    const registry = new ChatStreamRegistry();
    registry.setOwner("session-1", "user-a");
    expect(registry.isOwner("session-1", "user-a")).toBe(true);
    expect(registry.isOwner("session-1", "user-b")).toBe(false);
  });

  it("isOwner returns true for unowned sessions (first user claims it)", () => {
    const registry = new ChatStreamRegistry();
    expect(registry.isOwner("session-1", "user-a")).toBe(true);
  });
});
