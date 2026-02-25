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

  it("lists all streamIds for a sessionId", () => {
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
