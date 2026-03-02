import { describe, expect, it } from "vitest";
import { EchoChatBackend } from "./chat-backend.js";
import type { ChatEvent } from "./types.js";

async function collectEvents(message: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  const backend = new EchoChatBackend();
  await backend.process("sess-1", message, (e) => events.push(e));
  return events;
}

describe("EchoChatBackend", () => {
  it("echoes the message back as a text event", async () => {
    const events = await collectEvents("hello world");
    expect(events).toEqual([{ type: "text", delta: "Echo: hello world" }, { type: "done" }]);
  });

  it("sends a welcome greeting on empty message (first visit)", async () => {
    const events = await collectEvents("");
    expect(events).toEqual([{ type: "text", delta: "Welcome to WOPR! How can I help you today?" }, { type: "done" }]);
  });

  it("always ends with a done event", async () => {
    const events = await collectEvents("test");
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("produces exactly two events per call", async () => {
    const events = await collectEvents("any message");
    expect(events).toHaveLength(2);
  });

  it("sessionId is ignored (stub behavior)", async () => {
    const backend = new EchoChatBackend();
    const events1: ChatEvent[] = [];
    const events2: ChatEvent[] = [];
    await backend.process("session-A", "hi", (e) => events1.push(e));
    await backend.process("session-B", "hi", (e) => events2.push(e));
    expect(events1).toEqual(events2);
  });
});
