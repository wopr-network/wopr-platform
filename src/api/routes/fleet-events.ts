import { Hono } from "hono";
import { logger } from "../../config/logger.js";
import type { FleetEventEmitter } from "../../fleet/fleet-event-emitter.js";

export function createFleetEventsRoute(emitter: FleetEventEmitter): Hono {
  const routes = new Hono();

  routes.get("/", (c) => {
    const user = (c as unknown as { get(key: string): unknown }).get("user") as { id: string } | undefined;

    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // Derive tenantId exclusively from the authenticated session — never from
    // caller-supplied query params, which would allow IDOR (any user subscribing
    // to another tenant's events).
    const tenantId = user.id;

    const { readable, writable } = new TransformStream<string, string>();
    const writer = writable.getWriter();

    const unsub = emitter.subscribe((event) => {
      if (!("tenantId" in event)) return;
      if (event.tenantId !== tenantId) return;
      const payload = JSON.stringify({
        type: event.type,
        botId: event.botId,
        timestamp: event.timestamp,
      });
      writer.write(`event: fleet\ndata: ${payload}\n\n`).catch(() => {
        unsub();
        clearInterval(heartbeatTimer);
        logger.debug("Fleet SSE write error (client disconnected)");
      });
    });

    const heartbeatTimer = setInterval(() => {
      writer.write(": heartbeat\n\n").catch(() => {
        clearInterval(heartbeatTimer);
        unsub();
      });
    }, 30_000);

    const signal = c.req.raw.signal;
    if (signal) {
      signal.addEventListener("abort", () => {
        clearInterval(heartbeatTimer);
        unsub();
        writer.close().catch(() => {});
      });
    }

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return routes;
}
