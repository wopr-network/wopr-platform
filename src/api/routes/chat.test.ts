import type { AuthEnv } from "@wopr-network/platform-core/auth";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IChatBackend } from "../../chat/chat-backend.js";
import type { ChatEvent } from "../../chat/types.js";
import { chatRoutes, createChatRoutes, setChatDeps } from "./chat.js";

const TEST_SESSION = "550e8400-e29b-41d4-a716-446655440000";

function createMockBackend(events: ChatEvent[]): IChatBackend {
  return {
    process: vi.fn(async (_sessionId, _message, emit) => {
      for (const event of events) {
        emit(event);
      }
    }),
  };
}

// Helper: wrap chat routes with a fake user set on context
function createAuthedRoutes(deps: { backend: IChatBackend }) {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "test-user", roles: [] });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/", createChatRoutes(deps));
  return app;
}

describe("authentication", () => {
  it("GET /stream returns 401 without auth", async () => {
    const routes = createChatRoutes({ backend: createMockBackend([]) });
    const res = await routes.request(`/stream?sessionId=${TEST_SESSION}`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("POST / returns 401 without auth", async () => {
    const routes = createChatRoutes({ backend: createMockBackend([]) });
    const res = await routes.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: TEST_SESSION, message: "hello" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("GET /stream returns 200 with auth", async () => {
    const app = createAuthedRoutes({ backend: createMockBackend([]) });
    const res = await app.request(`/stream?sessionId=${TEST_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("POST / returns 200 with auth", async () => {
    const backend = createMockBackend([{ type: "done" }]);
    const app = createAuthedRoutes({ backend });
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: TEST_SESSION, message: "hello" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /", () => {
  it("returns 400 for missing sessionId", async () => {
    const app = createAuthedRoutes({ backend: createMockBackend([]) });
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing message field", async () => {
    const app = createAuthedRoutes({ backend: createMockBackend([]) });
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: TEST_SESSION }),
    });
    expect(res.status).toBe(400);
  });

  it("returns streamId on valid request", async () => {
    const backend = createMockBackend([{ type: "text", delta: "hi" }, { type: "done" }]);
    const app = createAuthedRoutes({ backend });
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: TEST_SESSION, message: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.streamId).toEqual(expect.any(String));
    expect(typeof body.streamId).toBe("string");
  });

  it("calls backend.process with sessionId and message", async () => {
    const backend = createMockBackend([{ type: "done" }]);
    const app = createAuthedRoutes({ backend });
    await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: TEST_SESSION, message: "test" }),
    });
    expect(backend.process).toHaveBeenCalledWith(TEST_SESSION, "test", expect.any(Function));
  });
});

describe("chatRoutes singleton — outer auth gate", () => {
  afterEach(() => {
    // Reset module-level singleton so each test starts clean.
    // setChatDeps replaces _deps; we also need to reset _chatRoutesInner.
    // Calling setChatDeps with a fresh mock is sufficient because
    // getChatRoutesInner() is re-created only when _chatRoutesInner is null.
    // Force recreation by resetting via setChatDeps.
    setChatDeps({ backend: createMockBackend([]) });
  });

  it("returns 401 on GET /stream when outer context has no user", async () => {
    setChatDeps({ backend: createMockBackend([]) });
    // chatRoutes receives a request with no user in context (simulates
    // a request that bypasses resolveSessionUser — proves the outer
    // lazy wrapper enforces auth before delegating to inner.fetch).
    const res = await chatRoutes.request(`/stream?sessionId=${TEST_SESSION}`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("returns 401 on POST / when outer context has no user", async () => {
    setChatDeps({ backend: createMockBackend([]) });
    const res = await chatRoutes.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: TEST_SESSION, message: "hello" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("does not reach the inner handler (returns 401 before delegating) when no user", async () => {
    // The outer lazy wrapper must short-circuit with 401 before calling
    // inner.fetch() — this confirms auth is enforced at the outer level.
    setChatDeps({ backend: createMockBackend([]) });
    const res = await chatRoutes.request(`/stream?sessionId=${TEST_SESSION}`);
    // Must be 401, not 404 or 500 (which would indicate it reached inner.fetch)
    expect(res.status).toBe(401);
  });

  it("forwards authenticated user to inner handler so authed requests succeed", async () => {
    // When user IS present in the outer context, the singleton wrapper must
    // forward the identity so inner handlers don't return 401.
    setChatDeps({ backend: createMockBackend([]) });
    const authedChatRoutes = new Hono<AuthEnv>();
    authedChatRoutes.use("/*", async (c, next) => {
      c.set("user", { id: "test-user", roles: [] });
      c.set("authMethod", "session");
      return next();
    });
    authedChatRoutes.route("/", chatRoutes);
    const res = await authedChatRoutes.request(`/stream?sessionId=${TEST_SESSION}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });
});

describe("GET /stream", () => {
  it("returns 400 without sessionId query param", async () => {
    const app = createAuthedRoutes({ backend: createMockBackend([]) });
    const res = await app.request("/stream");
    expect(res.status).toBe(400);
  });

  it("returns SSE content type with valid sessionId", async () => {
    const app = createAuthedRoutes({ backend: createMockBackend([]) });
    const res = await app.request(`/stream?sessionId=${TEST_SESSION}`);
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
    const app = createAuthedRoutes({ backend });

    // Open SSE connection
    const sseRes = await app.request(`/stream?sessionId=${TEST_SESSION}`);
    expect(sseRes.status).toBe(200);

    // Send a message (this triggers backend.process which writes to the SSE stream)
    const postRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: TEST_SESSION, message: "hello" }),
    });
    expect(postRes.status).toBe(200);

    // Read SSE body
    const text = await sseRes.text();
    expect(text).toContain('data: {"type":"text","delta":"Hello "}');
    expect(text).toContain('data: {"type":"tool_call"');
    expect(text).toContain('data: {"type":"done"}');
  });
});

// Helper: wrap chat routes with a specific user ID
function createAuthedRoutesForUser(deps: { backend: IChatBackend }, userId: string) {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: userId, roles: [] });
    c.set("authMethod", "session");
    return next();
  });
  app.route("/", createChatRoutes(deps));
  return app;
}

describe("session ownership (IDOR prevention)", () => {
  it("POST / with new sessionId succeeds and binds session to user", async () => {
    const backend = createMockBackend([{ type: "done" }]);
    const app = createAuthedRoutesForUser({ backend }, "user-a");
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: crypto.randomUUID(), message: "hello" }),
    });
    expect(res.status).toBe(200);
  });

  it("POST / returns 403 when user does not own the session", async () => {
    const backend = createMockBackend([{ type: "done" }]);
    const routes = createChatRoutes({ backend });

    const appA = new Hono<AuthEnv>();
    appA.use("/*", async (c, next) => {
      c.set("user", { id: "user-a", roles: [] });
      c.set("authMethod", "session");
      return next();
    });
    appA.route("/", routes);

    const appB = new Hono<AuthEnv>();
    appB.use("/*", async (c, next) => {
      c.set("user", { id: "user-b", roles: [] });
      c.set("authMethod", "session");
      return next();
    });
    appB.route("/", routes);

    const sessionId = crypto.randomUUID();

    const resA = await appA.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: "hello" }),
    });
    expect(resA.status).toBe(200);

    const resB = await appB.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: "injected" }),
    });
    expect(resB.status).toBe(403);
    const body = await resB.json();
    expect(body.error).toBe("Session access denied");
  });

  it("GET /stream returns 403 when user does not own the session", async () => {
    const backend = createMockBackend([{ type: "done" }]);
    const routes = createChatRoutes({ backend });

    const appA = new Hono<AuthEnv>();
    appA.use("/*", async (c, next) => {
      c.set("user", { id: "user-a", roles: [] });
      c.set("authMethod", "session");
      return next();
    });
    appA.route("/", routes);

    const appB = new Hono<AuthEnv>();
    appB.use("/*", async (c, next) => {
      c.set("user", { id: "user-b", roles: [] });
      c.set("authMethod", "session");
      return next();
    });
    appB.route("/", routes);

    const sessionId = crypto.randomUUID();

    await appA.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: "hello" }),
    });

    const resB = await appB.request(`/stream?sessionId=${sessionId}`);
    expect(resB.status).toBe(403);
    const body = await resB.json();
    expect(body.error).toBe("Session access denied");
  });

  it("GET /stream claims unclaimed session so a subsequent GET by another user is denied", async () => {
    // IDOR: attacker GETs /stream on an unclaimed sessionId first, then victim POSTs.
    // The attacker's GET should claim ownership so the victim's subsequent GET is denied.
    const backend = createMockBackend([{ type: "done" }]);
    const routes = createChatRoutes({ backend });

    const attackerApp = new Hono<AuthEnv>();
    attackerApp.use("/*", async (c, next) => {
      c.set("user", { id: "attacker", roles: [] });
      c.set("authMethod", "session");
      return next();
    });
    attackerApp.route("/", routes);

    const victimApp = new Hono<AuthEnv>();
    victimApp.use("/*", async (c, next) => {
      c.set("user", { id: "victim", roles: [] });
      c.set("authMethod", "session");
      return next();
    });
    victimApp.route("/", routes);

    const sessionId = crypto.randomUUID();

    // Attacker subscribes first on an unclaimed session
    const attackerStreamRes = await attackerApp.request(`/stream?sessionId=${sessionId}`);
    expect(attackerStreamRes.status).toBe(200);

    // Victim tries to stream the same session — should be 403
    const victimStreamRes = await victimApp.request(`/stream?sessionId=${sessionId}`);
    expect(victimStreamRes.status).toBe(403);
    const body = await victimStreamRes.json();
    expect(body.error).toBe("Session access denied");
  });

  it("POST / rejects non-UUID sessionId", async () => {
    const backend = createMockBackend([{ type: "done" }]);
    const app = createAuthedRoutesForUser({ backend }, "user-a");
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "short", message: "hello" }),
    });
    expect(res.status).toBe(400);
  });
});
