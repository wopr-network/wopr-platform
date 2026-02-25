import { describe, expect, it, vi } from "vitest";
import type { IChatBackend } from "../../chat/chat-backend.js";
import type { ChatEvent } from "../../chat/types.js";
import { createChatRoutes } from "./chat.js";

function createMockBackend(events: ChatEvent[]): IChatBackend {
  return {
    process: vi.fn(async (_sessionId, _message, emit) => {
      for (const event of events) {
        emit(event);
      }
    }),
  };
}

describe("POST /", () => {
  it("returns 400 for missing sessionId", async () => {
    const routes = createChatRoutes({ backend: createMockBackend([]) });
    const res = await routes.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing message field", async () => {
    const routes = createChatRoutes({ backend: createMockBackend([]) });
    const res = await routes.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns streamId on valid request", async () => {
    const backend = createMockBackend([{ type: "text", delta: "hi" }, { type: "done" }]);
    const routes = createChatRoutes({ backend });
    const res = await routes.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.streamId).toBeDefined();
    expect(typeof body.streamId).toBe("string");
  });

  it("calls backend.process with sessionId and message", async () => {
    const backend = createMockBackend([{ type: "done" }]);
    const routes = createChatRoutes({ backend });
    await routes.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "test" }),
    });
    expect(backend.process).toHaveBeenCalledWith("s1", "test", expect.any(Function));
  });
});

describe("GET /stream", () => {
  it("returns 400 without sessionId query param", async () => {
    const routes = createChatRoutes({ backend: createMockBackend([]) });
    const res = await routes.request("/stream");
    expect(res.status).toBe(400);
  });

  it("returns SSE content type with valid sessionId", async () => {
    const routes = createChatRoutes({ backend: createMockBackend([]) });
    const res = await routes.request("/stream?sessionId=s1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
  });

  it("streams events from POST to GET", async () => {
    const backend: IChatBackend = {
      process: vi.fn(async (_sessionId, _message, emit) => {
        emit({ type: "text", delta: "Hello " });
        emit({ type: "tool_call", tool: "marketplace.showSuperpowers", args: { query: "sec" } });
        emit({ type: "done" });
      }),
    };
    const routes = createChatRoutes({ backend });

    // Open SSE connection
    const sseRes = await routes.request("/stream?sessionId=s1");
    expect(sseRes.status).toBe(200);

    // Send a message (this triggers backend.process which writes to the SSE stream)
    const postRes = await routes.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hello" }),
    });
    expect(postRes.status).toBe(200);

    // Read SSE body
    const text = await sseRes.text();
    expect(text).toContain('data: {"type":"text","delta":"Hello "}');
    expect(text).toContain('data: {"type":"tool_call"');
    expect(text).toContain('data: {"type":"done"}');
  });
});
