import { describe, expect, it, vi } from "vitest";
import { GraduatingChatBackend, type IChatBackend } from "./chat-backend.js";
import type { ChatEvent } from "./types.js";

async function collectEvents(backend: IChatBackend, sessionId: string, message: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  await backend.process(sessionId, message, (e) => events.push(e));
  return events;
}

describe("GraduatingChatBackend", () => {
  it("delegates to user backend when session is graduated", async () => {
    const platformBackend: IChatBackend = {
      process: vi.fn(),
    };
    const userBackend: IChatBackend = {
      process: vi.fn(async (_sid, _msg, emit) => {
        emit({ type: "text", delta: "from user bot" });
        emit({ type: "done" });
      }),
    };
    const resolveBackend = vi.fn(async (_sessionId: string) => userBackend);

    const backend = new GraduatingChatBackend(platformBackend, resolveBackend);
    const events = await collectEvents(backend, "sess-1", "hello");

    expect(resolveBackend).toHaveBeenCalledWith("sess-1");
    expect(userBackend.process).toHaveBeenCalled();
    expect(platformBackend.process).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "text", delta: "from user bot" }, { type: "done" }]);
  });

  it("delegates to platform backend when session is not graduated", async () => {
    const platformBackend: IChatBackend = {
      process: vi.fn(async (_sid, _msg, emit) => {
        emit({ type: "text", delta: "from platform" });
        emit({ type: "done" });
      }),
    };
    const resolveBackend = vi.fn(async (_sessionId: string) => null);

    const backend = new GraduatingChatBackend(platformBackend, resolveBackend);
    const events = await collectEvents(backend, "sess-1", "hello");

    expect(platformBackend.process).toHaveBeenCalled();
    expect(events).toEqual([{ type: "text", delta: "from platform" }, { type: "done" }]);
  });
});
