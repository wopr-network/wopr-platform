import { Hono } from "hono";
import { z } from "zod";
import type { IChatBackend } from "../../chat/chat-backend.js";
import { ChatStreamRegistry, type SSEWriter } from "../../chat/chat-stream-registry.js";
import type { ChatEvent } from "../../chat/types.js";
import { logger } from "../../config/logger.js";

const chatRequestSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string(), // empty string = greeting trigger
});

export interface ChatRouteDeps {
  backend: IChatBackend;
}

/**
 * Create chat routes with injected dependencies.
 * Enables testing without real WOPR instances.
 */
export function createChatRoutes(deps: ChatRouteDeps): Hono {
  const routes = new Hono();
  const registry = new ChatStreamRegistry();

  /**
   * GET /stream?sessionId=X
   * Opens an SSE connection. Events are pushed when POST / is called.
   */
  routes.get("/stream", (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
      return c.json({ error: "sessionId query parameter is required" }, 400);
    }

    const { readable, writable } = new TransformStream<string, string>();
    const writer = writable.getWriter();

    const sseWriter: SSEWriter = {
      write(chunk: string) {
        writer.write(chunk).catch(() => {
          // Client disconnected — ignore write errors
        });
      },
      close() {
        writer.close().catch(() => {});
      },
    };

    const streamId = registry.register(sessionId, sseWriter);

    // Clean up on client disconnect
    const signal = c.req.raw.signal;
    if (signal) {
      signal.addEventListener("abort", () => {
        registry.remove(streamId);
        writer.close().catch(() => {});
      });
    }

    const encoder = new TextEncoder();
    const encodedStream = readable.pipeThrough(
      new TransformStream<string, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(encoder.encode(chunk));
        },
      }),
    );

    return new Response(encodedStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  /**
   * POST /
   * Send a message to the session. Returns streamId immediately.
   * Events are pushed to all SSE connections for this sessionId.
   */
  routes.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const { sessionId, message } = parsed.data;
    const streamIds = registry.listBySession(sessionId);

    // Fire-and-forget: process in background so POST returns immediately
    const emit = (event: ChatEvent) => {
      const line = `data: ${JSON.stringify(event)}\n\n`;
      for (const id of streamIds) {
        const writer = registry.get(id);
        if (writer) {
          writer.write(line);
          if (event.type === "done") {
            writer.close();
            registry.remove(id);
          }
        }
      }
    };

    // Start processing (don't await — return streamId immediately)
    deps.backend.process(sessionId, message, emit).catch((err) => {
      logger.error("Chat backend processing failed", { sessionId, err });
      emit({ type: "error", message: "Internal error" });
      emit({ type: "done" });
    });

    // Return the first streamId (or "pending" if no SSE connection yet)
    return c.json({ streamId: streamIds[0] ?? "pending" });
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Default singleton (wired at startup via setChatDeps)
// ---------------------------------------------------------------------------

let _deps: ChatRouteDeps | null = null;

export function setChatDeps(deps: ChatRouteDeps): void {
  _deps = deps;
}

function getDeps(): ChatRouteDeps {
  if (!_deps) {
    throw new Error("Chat route deps not initialized — call setChatDeps() before serving requests");
  }
  return _deps;
}

/** Pre-built chat routes with lazy dep initialization. */
export const chatRoutes = new Hono();
chatRoutes.route(
  "/",
  (() => {
    // Lazy wrapper: defers createChatRoutes until first request
    const lazy = new Hono();
    lazy.all("/*", async (c) => {
      const inner = createChatRoutes(getDeps());
      return inner.fetch(c.req.raw);
    });
    return lazy;
  })(),
);
