import type { IDaemonManager } from "@wopr-network/platform-core/onboarding/daemon-manager";
import type { OnboardingService } from "@wopr-network/platform-core/onboarding/onboarding-service";
import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "./types.js";
import { WoprChatBackend } from "./wopr-chat-backend.js";

function mockClient(response = "Hello from WOPR"): Pick<OnboardingService, "inject"> {
  return {
    inject: vi.fn().mockResolvedValue(response),
  };
}

function mockDaemon(ready = true): IDaemonManager {
  return { start: vi.fn(), stop: vi.fn(), isReady: vi.fn().mockReturnValue(ready) };
}

async function collectEvents(backend: WoprChatBackend, sessionId: string, message: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  await backend.process(sessionId, message, (e) => events.push(e));
  return events;
}

describe("WoprChatBackend", () => {
  it("delegates to client.inject and emits text + done", async () => {
    const client = mockClient("Hello from WOPR");
    const backend = new WoprChatBackend(client, mockDaemon());

    const events = await collectEvents(backend, "sess-1", "hi");

    expect(client.inject).toHaveBeenCalledWith("sess-1", "hi", { from: "user" });
    expect(events).toEqual([{ type: "text", delta: "Hello from WOPR" }, { type: "done" }]);
  });

  it("emits error when daemon is not ready", async () => {
    const client = mockClient();
    const backend = new WoprChatBackend(client, mockDaemon(false));

    const events = await collectEvents(backend, "sess-1", "hi");

    expect(client.inject).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "error", message: "WOPR daemon is not ready" }, { type: "done" }]);
  });

  it("emits generic error when client.inject throws", async () => {
    const client = mockClient();
    (client.inject as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection refused"));
    const backend = new WoprChatBackend(client, mockDaemon());

    const events = await collectEvents(backend, "sess-1", "hi");

    expect(events).toEqual([{ type: "error", message: "An error occurred" }, { type: "done" }]);
  });

  it("forwards empty message to WOPR instance", async () => {
    const client = mockClient("Welcome!");
    const backend = new WoprChatBackend(client, mockDaemon());

    const events = await collectEvents(backend, "sess-1", "");

    expect(client.inject).toHaveBeenCalledWith("sess-1", "", { from: "user" });
    expect(events).toEqual([{ type: "text", delta: "Welcome!" }, { type: "done" }]);
  });

  it("always ends with done event", async () => {
    const client = mockClient("response");
    const backend = new WoprChatBackend(client, mockDaemon());

    const events = await collectEvents(backend, "sess-1", "test");

    expect(events[events.length - 1]).toEqual({ type: "done" });
  });
});
